//! Atomic metadata edits for an observed physical project selection.
use super::{Store, project_row};
use crate::error::{CoreError, Result};
use orbyn_contracts::{Project, ProjectScopeCatalog};
use rusqlite::params;
use std::{collections::BTreeMap, path::Path};

impl Store {
    pub(crate) fn rename_selected_projects(
        &self,
        catalog: &ProjectScopeCatalog,
        library_root: &Path,
        expected_names: &BTreeMap<String, String>,
        name: &str,
    ) -> Result<Vec<Project>> {
        self.commit(|tx, _| {
            let mut statement = tx.prepare("SELECT * FROM projects WHERE scratch = 0")?;
            let projects = statement
                .query_map([], project_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            crate::project_scopes::fence_members(&projects, catalog, library_root)?;
            let mut selected = Vec::new();
            for (id, expected) in expected_names {
                let project = projects
                    .iter()
                    .find(|project| &project.id == id)
                    .ok_or(CoreError::SettingsConflict)?;
                if Path::new(&project.path) == library_root || &project.name != expected {
                    return Err(CoreError::SettingsConflict);
                }
                selected.push(project.clone());
            }
            for project in &mut selected {
                project.name = name.to_owned();
            }
            if serde_json::to_vec(&selected)?.len()
                > crate::project_scopes::MAX_PROJECT_METADATA_BYTES
            {
                return Err(CoreError::Invalid(
                    "This settings scope is too large.".into(),
                ));
            }
            // Every compare precedes every update; failures roll back the whole group.
            for project in &selected {
                tx.execute(
                    "UPDATE projects SET name = ?2 WHERE id = ?1",
                    params![project.id, name],
                )?;
            }
            Ok(selected)
        })
    }
}
