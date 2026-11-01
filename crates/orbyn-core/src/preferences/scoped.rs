//! Scoped resolution and edit planning. Git and file observation happens before
//! SQLite; transaction callbacks only compare snapshots and prepare owned writes.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use orbyn_contracts::{
    PreferenceEdit, PreferenceFileValue, PreferenceView, ProjectFileView, ProjectScopeCatalog,
    ResolvedProjectSettingsScope, ScopedPreferenceMember, ScopedPreferenceOverride,
    ScopedPreferenceRow, ScopedPreferencesChange, ScopedPreferencesQuery, ScopedPreferencesResult,
};
use serde_json::{Value, json};

use super::{DEFINITIONS, Kind, check, definition, normalized, setting_key};
use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::scoped_settings::{ServerSettingField, SettingWrite, SettingsSnapshot};
use crate::util::sha256_hex;

const MAX_KEYS: usize = 128;
const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
type Files = BTreeMap<String, ProjectFileView>;

pub(super) fn observe_files<'a>(
    snapshot: &SettingsSnapshot,
    ids: impl IntoIterator<Item = &'a str>,
) -> Result<Files> {
    ids.into_iter()
        .map(|id| {
            let project = snapshot
                .projects
                .iter()
                .find(|project| project.id == id)
                .ok_or_else(|| CoreError::NotFound("project".into()))?;
            Ok((
                id.to_owned(),
                crate::project_file::read_project_file(Path::new(&project.path)),
            ))
        })
        .collect()
}

fn global_value(snapshot: &SettingsSnapshot, key: &str) -> Result<Option<Value>> {
    // A legacy preference remains readable until the next canonical write clears it.
    if let Some(text) = snapshot.globals.get(&setting_key(key)) {
        return Ok(Some(serde_json::from_str(text)?));
    }
    if !matches!(
        key,
        "auto_settle_after_days"
            | "auto_settle_on_merge"
            | "auto_settle_keep_pull_requests"
            | "project_title_instructions"
    ) {
        return Ok(None);
    }
    let Some(text) = snapshot.globals.get("server_settings") else {
        return Ok(None);
    };
    let server: Value = serde_json::from_str(text)?;
    let value = match key {
        "auto_settle_after_days" => server.pointer("/auto_settle/after_days").cloned(),
        "auto_settle_on_merge" => server.pointer("/auto_settle/on_merge").cloned(),
        "auto_settle_keep_pull_requests" => {
            server.pointer("/auto_settle/keep_pull_requests").cloned()
        }
        "project_title_instructions" => server
            .get("title_instructions")
            .filter(|value| !value.is_null())
            .cloned(),
        _ => None,
    };
    Ok(value)
}

pub(super) fn resolved_views(
    snapshot: &SettingsSnapshot,
    files: &Files,
    project_id: Option<&str>,
) -> Result<Vec<PreferenceView>> {
    resolved_views_from_file(snapshot, files, project_id, None)
}

pub(super) fn resolved_views_from_file(
    snapshot: &SettingsSnapshot,
    files: &Files,
    project_id: Option<&str>,
    checkout_file: Option<&ProjectFileView>,
) -> Result<Vec<PreferenceView>> {
    if let Some(id) = project_id
        && !snapshot.projects.iter().any(|project| project.id == id)
    {
        return Err(CoreError::NotFound("project".into()));
    }
    DEFINITIONS
        .iter()
        .map(|definition| {
            let default = (definition.default)();
            let global = global_value(snapshot, definition.key)?;
            let local = project_id
                .filter(|_| definition.project)
                .and_then(|id| snapshot.overrides.get(id))
                .and_then(|own| own.get(definition.key));
            let project_file = checkout_file
                .or_else(|| project_id.and_then(|id| files.get(id)))
                .and_then(|file| {
                    let contents = file.file.as_ref()?;
                    let value = match definition.key {
                        "default_thread_env_mode" => contents
                            .default_thread_env_mode
                            .as_ref()
                            .map(|value| json!(value)),
                        "worktree_submodules" => contents
                            .worktree_submodules
                            .as_ref()
                            .map(|value| json!(value)),
                        "default_project_scripts" if !contents.scripts.is_empty() => {
                            Some(json!(contents.scripts))
                        }
                        _ => None,
                    }?;
                    Some(PreferenceFileValue {
                        path: file.path.clone()?,
                        value,
                    })
                });
            let (value, source) = match (local, global, project_file.as_ref()) {
                (Some(text), _, _) => (serde_json::from_str(text)?, "project"),
                (None, Some(value), _) => (value, "global"),
                (None, None, Some(file)) => (file.value.clone(), "file"),
                _ => (default.clone(), "default"),
            };
            Ok(PreferenceView {
                key: definition.key.into(),
                value: normalized(definition.key, value),
                default,
                source: source.into(),
                project_file,
                project_scoped: definition.project,
            })
        })
        .collect()
}

pub(super) fn prepare_write(
    writes: &mut Vec<SettingWrite>,
    key: &str,
    project: Option<&str>,
    value: Option<&Value>,
) {
    if let Some(id) = project {
        writes.push(SettingWrite::Project {
            project_id: id.into(),
            key: key.into(),
            value: value.map(Value::to_string),
        });
        return;
    }
    let field = match key {
        "auto_settle_after_days" => Some(ServerSettingField::AutoSettleAfterDays),
        "auto_settle_on_merge" => Some(ServerSettingField::AutoSettleOnMerge),
        "auto_settle_keep_pull_requests" => Some(ServerSettingField::AutoSettleKeepPullRequests),
        "project_title_instructions" => Some(ServerSettingField::TitleInstructions),
        _ => None,
    };
    if let Some(field) = field {
        let fallback = (definition(key).expect("fixed catalog key").default)();
        let value = value
            .cloned()
            .unwrap_or(if key == "project_title_instructions" {
                Value::Null
            } else {
                fallback
            });
        writes.push(SettingWrite::ServerField { field, value });
        writes.push(SettingWrite::Global {
            key: setting_key(key),
            value: None,
        });
    } else {
        writes.push(SettingWrite::Global {
            key: setting_key(key),
            value: value.map(Value::to_string),
        });
    }
}

fn set_value(
    snapshot: &SettingsSnapshot,
    files: &Files,
    key: &str,
    project: Option<&str>,
    patch: &Value,
) -> Result<Value> {
    let definition = definition(key)?;
    let value = if matches!(definition.kind, Kind::Object) {
        let current = resolved_views(snapshot, files, project)?
            .into_iter()
            .find(|view| view.key == key)
            .expect("validated catalog key")
            .value;
        let mut object = current
            .as_object()
            .cloned()
            .ok_or_else(|| CoreError::Invalid("The current setting is not an object.".into()))?;
        // Compound controls edit top-level fields. A mixed group must preserve
        // each member's other fields instead of copying the first member's map.
        object.extend(patch.as_object().expect("validated object patch").clone());
        Value::Object(object)
    } else {
        patch.clone()
    };
    check(definition, &value)?;
    if value.to_string().len() > MAX_VALUE_BYTES {
        return Err(CoreError::Invalid("Setting value is too large.".into()));
    }
    Ok(value)
}

fn keys(requested: &[String]) -> Result<Vec<String>> {
    let result = if requested.is_empty() {
        DEFINITIONS.iter().map(|d| d.key.to_owned()).collect()
    } else {
        requested.to_vec()
    };
    if result.len() > MAX_KEYS
        || result.iter().any(|key| key.len() > 128)
        || result.iter().collect::<BTreeSet<_>>().len() != result.len()
    {
        return Err(CoreError::Invalid("Choose each settings key once.".into()));
    }
    for key in &result {
        definition(key)?;
    }
    Ok(result)
}

fn selected(catalog: &ProjectScopeCatalog) -> Result<Vec<String>> {
    match &catalog.selection {
        ResolvedProjectSettingsScope::AllProjects => Ok(Vec::new()),
        ResolvedProjectSettingsScope::ProjectGroup {
            group_key,
            project_ids,
        } => {
            let group = catalog
                .groups
                .iter()
                .find(|group| &group.key == group_key)
                .ok_or(CoreError::SettingsScopeUnavailable)?;
            if group.members.iter().any(|member| {
                !member.metadata_complete
                    && member.grouping_mode != orbyn_contracts::ProjectGroupingMode::Separate
            }) {
                return Err(CoreError::SettingsScopeUnavailable);
            }
            Ok(project_ids.clone())
        }
        ResolvedProjectSettingsScope::Checkout { project_id, .. } => Ok(vec![project_id.clone()]),
        ResolvedProjectSettingsScope::Unavailable { .. } => {
            Err(CoreError::SettingsScopeUnavailable)
        }
    }
}

fn visible_members(catalog: &ProjectScopeCatalog) -> BTreeMap<String, String> {
    catalog
        .groups
        .iter()
        .flat_map(|group| &group.members)
        .filter_map(|member| Some((member.project_id.clone(), member.path.clone()?)))
        .collect()
}
fn fence(
    snapshot: &SettingsSnapshot,
    catalog: &ProjectScopeCatalog,
    library_root: &Path,
) -> Result<()> {
    let current: BTreeMap<_, _> = snapshot
        .projects
        .iter()
        .filter(|project| Path::new(&project.path) != library_root)
        .map(|project| (project.id.clone(), project.path.clone()))
        .collect();
    if current != visible_members(catalog) {
        return Err(CoreError::SettingsConflict);
    }
    Ok(())
}

fn rows(
    snapshot: &SettingsSnapshot,
    files: &Files,
    catalog: &ProjectScopeCatalog,
    requested: &[String],
) -> Result<Vec<ScopedPreferenceRow>> {
    let ids = selected(catalog)?;
    // Bound repeated inherited values before cloning them across every member.
    let global_bytes: usize = snapshot.globals.values().map(String::len).sum();
    let override_bytes: usize = snapshot
        .overrides
        .values()
        .flat_map(|own| own.values())
        .map(String::len)
        .sum();
    let estimate = global_bytes
        .saturating_mul(ids.len().saturating_add(2))
        .saturating_add(override_bytes.saturating_mul(2));
    if estimate > MAX_RESPONSE_BYTES {
        return Err(CoreError::Invalid(
            "This settings scope is too large.".into(),
        ));
    }
    let environment: BTreeMap<_, _> = resolved_views(snapshot, files, None)?
        .into_iter()
        .map(|view| (view.key.clone(), view))
        .collect();
    let visible = visible_members(catalog);
    let mut member_views = BTreeMap::new();
    for id in &ids {
        member_views.insert(id.clone(), resolved_views(snapshot, files, Some(id))?);
    }
    requested
        .iter()
        .map(|key| {
            let env = environment.get(key).expect("validated key").clone();
            let members = ids
                .iter()
                .map(|id| {
                    let project = snapshot
                        .projects
                        .iter()
                        .find(|project| &project.id == id)
                        .ok_or(CoreError::SettingsConflict)?;
                    let view = member_views[id]
                        .iter()
                        .find(|view| &view.key == key)
                        .expect("fixed catalog")
                        .clone();
                    Ok(ScopedPreferenceMember {
                        project_id: Some(id.clone()),
                        name: Some(project.name.clone()),
                        view,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let value = members
                .first()
                .map_or_else(|| env.value.clone(), |member| member.view.value.clone());
            let mixed = members.iter().any(|member| member.view.value != value);
            let overrides = snapshot
                .projects
                .iter()
                .filter(|project| visible.contains_key(&project.id))
                .filter_map(|project| {
                    Some((project, snapshot.overrides.get(&project.id)?.get(key)?))
                })
                .map(|(project, text)| {
                    Ok(ScopedPreferenceOverride {
                        project_id: project.id.clone(),
                        name: project.name.clone(),
                        value: normalized(key, serde_json::from_str(text)?),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            // Presence/source are fenced too: an equal explicit override is resettable.
            let digest =
                serde_json::to_vec(&(key, &catalog.selection, &env, &members, &overrides))?;
            Ok(ScopedPreferenceRow {
                key: key.clone(),
                value: if mixed { Value::Null } else { value },
                mixed,
                default: env.default.clone(),
                project_scoped: env.project_scoped,
                revision: sha256_hex(&digest),
                environment: env,
                members,
                overrides,
            })
        })
        .collect()
}

impl Core {
    pub async fn scoped_preferences(
        &self,
        query: &ScopedPreferencesQuery,
    ) -> Result<ScopedPreferencesResult> {
        let requested = keys(&query.keys)?;
        let catalog = self.project_scope_catalog(&query.scope).await?;
        selected(&catalog)?;
        let snapshot = self.store.settings_snapshot()?;
        fence(&snapshot, &catalog, &self.workspace.root()?)?;
        let ids = selected(&catalog)?;
        let files = observe_files(&snapshot, ids.iter().map(String::as_str))?;
        let result = ScopedPreferencesResult {
            rows: rows(&snapshot, &files, &catalog, &requested)?,
            catalog,
        };
        if serde_json::to_vec(&result)?.len() > MAX_RESPONSE_BYTES {
            return Err(CoreError::Invalid(
                "This settings scope is too large.".into(),
            ));
        }
        Ok(result)
    }

    pub async fn change_scoped_preferences(
        &self,
        change: &ScopedPreferencesChange,
    ) -> Result<ScopedPreferencesResult> {
        if change.edits.is_empty() {
            return Err(CoreError::Invalid("Choose settings to change.".into()));
        }
        let requested = keys(&change.edits.keys().cloned().collect::<Vec<_>>())?;
        if change.if_match.keys().collect::<BTreeSet<_>>()
            != change.edits.keys().collect::<BTreeSet<_>>()
        {
            return Err(CoreError::Invalid(
                "Supply one revision for each edited setting.".into(),
            ));
        }
        let catalog = self.project_scope_catalog(&change.scope).await?;
        let ids = selected(&catalog)?;
        if catalog.version != change.membership_version {
            return Err(CoreError::SettingsConflict);
        }
        let before = self.store.settings_snapshot()?;
        let files = observe_files(&before, ids.iter().map(String::as_str))?;
        let root = self.workspace.root()?;
        // Provider configuration validation is outside SQLite and precedes all writes.
        for (key, edit) in &change.edits {
            let definition = definition(key)?;
            if !ids.is_empty() && !definition.project {
                return Err(CoreError::Invalid(format!("{key} is not set per project.")));
            }
            if let PreferenceEdit::Set { value } = edit {
                if value.to_string().len() > MAX_VALUE_BYTES {
                    return Err(CoreError::Invalid("Setting value is too large.".into()));
                }
                check(definition, value)?;
                if key == crate::engines::instances::PREFERENCE {
                    self.engines
                        .check_instances(&crate::engines::instances::parse(value)?)?;
                }
            }
        }
        self.store.change_settings(|snapshot| {
            fence(snapshot, &catalog, &root)?;
            for row in rows(snapshot, &files, &catalog, &requested)? {
                if change.if_match.get(&row.key) != Some(&row.revision) {
                    return Err(CoreError::SettingsConflict);
                }
            }
            let visible = visible_members(&catalog);
            let mut writes = Vec::new();
            for (key, edit) in &change.edits {
                match edit {
                    PreferenceEdit::ResetOverrides { project_ids } => {
                        if !ids.is_empty()
                            || !definition(key)?.project
                            || project_ids.is_empty()
                            || project_ids.len() > 512
                            || project_ids.iter().collect::<BTreeSet<_>>().len()
                                != project_ids.len()
                        {
                            return Err(CoreError::Invalid(
                                "Choose explicit project overrides from All projects.".into(),
                            ));
                        }
                        for id in project_ids {
                            if !visible.contains_key(id) {
                                return Err(CoreError::SettingsConflict);
                            }
                            prepare_write(&mut writes, key, Some(id), None);
                        }
                    }
                    PreferenceEdit::Set { value } => {
                        if ids.is_empty() {
                            let merged = set_value(snapshot, &files, key, None, value)?;
                            prepare_write(&mut writes, key, None, Some(&merged));
                        } else {
                            for id in &ids {
                                let merged = set_value(snapshot, &files, key, Some(id), value)?;
                                prepare_write(&mut writes, key, Some(id), Some(&merged));
                            }
                        }
                    }
                    PreferenceEdit::Inherit {} => {
                        if ids.is_empty() {
                            prepare_write(&mut writes, key, None, None);
                        } else {
                            for id in &ids {
                                prepare_write(&mut writes, key, Some(id), None);
                            }
                        }
                    }
                }
            }
            // Reject an oversized fan-out before committing rather than failing
            // only while serializing the refreshed response after the write.
            let mut global_sizes: BTreeMap<_, _> = snapshot
                .globals
                .iter()
                .map(|(key, value)| (key.clone(), value.len()))
                .collect();
            let mut project_sizes: BTreeMap<_, _> = snapshot
                .overrides
                .iter()
                .flat_map(|(id, own)| {
                    own.iter()
                        .map(move |(key, value)| ((id.clone(), key.clone()), value.len()))
                })
                .collect();
            let mut server_growth = 0usize;
            for write in &writes {
                match write {
                    SettingWrite::Global { key, value } => match value {
                        Some(value) => {
                            global_sizes.insert(key.clone(), value.len());
                        }
                        None => {
                            global_sizes.remove(key);
                        }
                    },
                    SettingWrite::Project {
                        project_id,
                        key,
                        value,
                    } => {
                        let target = (project_id.clone(), key.clone());
                        match value {
                            Some(value) => {
                                project_sizes.insert(target, value.len());
                            }
                            None => {
                                project_sizes.remove(&target);
                            }
                        }
                    }
                    SettingWrite::ServerField { value, .. } => {
                        server_growth = server_growth.saturating_add(value.to_string().len())
                    }
                }
            }
            let global_bytes = global_sizes
                .values()
                .fold(server_growth, |total, bytes| total.saturating_add(*bytes));
            let project_bytes = project_sizes
                .values()
                .fold(0usize, |total, bytes| total.saturating_add(*bytes));
            if global_bytes
                .saturating_mul(ids.len().saturating_add(2))
                .saturating_add(project_bytes.saturating_mul(3))
                > MAX_RESPONSE_BYTES
            {
                return Err(CoreError::Invalid(
                    "This settings scope is too large.".into(),
                ));
            }
            Ok(((), writes))
        })?;
        if change.edits.contains_key("prefer_saved_login") {
            self.apply_login_preference()?;
        }
        self.scoped_preferences(&ScopedPreferencesQuery {
            scope: change.scope.clone(),
            keys: requested,
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_repository_grouping_cannot_partially_fan_out() {
        let mut catalog: ProjectScopeCatalog = serde_json::from_value(json!({
            "version":"fixture", "metadata_complete":false,
            "groups":[{"key":"group", "label":"one", "members":[{
                "project_id":"one","physical_key":"checkout","name":"one","path":"/one",
                "grouping_mode":"repository","metadata_complete":false
            }]}],
            "selection":{"kind":"project_group","group_key":"group","project_ids":["one"]}
        }))
        .unwrap();
        assert!(matches!(
            selected(&catalog),
            Err(CoreError::SettingsScopeUnavailable)
        ));
        catalog.groups[0].members[0].metadata_complete = true;
        assert_eq!(selected(&catalog).unwrap(), vec!["one"]);
        catalog.groups[0].members[0].metadata_complete = false;
        catalog.groups[0].members[0].grouping_mode = orbyn_contracts::ProjectGroupingMode::Separate;
        assert_eq!(selected(&catalog).unwrap(), vec!["one"]);
        catalog.selection = ResolvedProjectSettingsScope::Checkout {
            group_key: "group".into(),
            project_id: "one".into(),
        };
        assert_eq!(selected(&catalog).unwrap(), vec!["one"]);
        catalog.selection = ResolvedProjectSettingsScope::AllProjects;
        assert!(selected(&catalog).unwrap().is_empty());
    }
}
