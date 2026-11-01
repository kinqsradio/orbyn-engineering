//! Atomic metadata edits for an observed physical project selection.
use super::{Store, project_row};
use crate::error::{CoreError, Result};
use orbyn_contracts::{Project, ProjectIconOverride, ProjectScopeCatalog};
use rusqlite::params;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy)]
enum Expected<'a> {
    Names(&'a BTreeMap<String, String>),
    Revisions(&'a BTreeMap<String, String>),
}
#[derive(Clone, Copy)]
enum Edit<'a> {
    Name(&'a str),
    Icon(&'a Option<ProjectIconOverride>),
}

impl Store {
    pub(crate) fn rename_selected_projects(
        &self,
        catalog: &ProjectScopeCatalog,
        library_root: &Path,
        expected: &BTreeMap<String, String>,
        name: &str,
    ) -> Result<Vec<Project>> {
        self.edit_project_metadata(
            catalog,
            library_root,
            Expected::Names(expected),
            Edit::Name(name),
        )
    }
    pub(crate) fn change_selected_project_icon(
        &self,
        catalog: &ProjectScopeCatalog,
        library_root: &Path,
        expected: &BTreeMap<String, String>,
        icon: &Option<ProjectIconOverride>,
    ) -> Result<Vec<Project>> {
        self.edit_project_metadata(
            catalog,
            library_root,
            Expected::Revisions(expected),
            Edit::Icon(icon),
        )
    }
    fn edit_project_metadata(
        &self,
        catalog: &ProjectScopeCatalog,
        library_root: &Path,
        expected: Expected<'_>,
        edit: Edit<'_>,
    ) -> Result<Vec<Project>> {
        self.commit(|tx, _| {
            let mut statement = tx.prepare("SELECT * FROM projects WHERE scratch = 0")?;
            let projects = statement
                .query_map([], project_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            crate::project_scopes::fence_members(&projects, catalog, library_root)?;
            let expected_map = match expected {
                Expected::Names(values) | Expected::Revisions(values) => values,
            };
            let mut selected = Vec::new();
            for (id, value) in expected_map {
                let mut project = projects
                    .iter()
                    .find(|p| &p.id == id)
                    .ok_or(CoreError::SettingsConflict)?
                    .clone();
                let matches = match expected {
                    Expected::Names(_) => project.name == *value,
                    Expected::Revisions(_) => project.metadata_revision == *value,
                };
                if Path::new(&project.path) == library_root || !matches {
                    return Err(CoreError::SettingsConflict);
                }
                let next = crate::project_icon_override::revision(&project.metadata_revision)?
                    .checked_add(1)
                    .ok_or_else(|| CoreError::Invalid("Project metadata revision is exhausted.".into()))?;
                project.metadata_revision = next.to_string();
                match edit {
                    Edit::Name(name) => project.name = name.to_owned(),
                    Edit::Icon(icon) => {
                        project.project_icon = icon.clone();
                        project.favicon_path = None;
                    }
                }
                selected.push(project);
            }
            if serde_json::to_vec(&selected)?.len() > crate::project_scopes::MAX_PROJECT_METADATA_BYTES {
                return Err(CoreError::Invalid("This settings scope is too large.".into()));
            }
            // Compare the complete selection before any partial-column update.
            for project in &selected {
                let revision = crate::project_icon_override::revision(&project.metadata_revision)?;
                match edit {
                    Edit::Name(name) => {
                        tx.execute(
                            "UPDATE projects SET name=?2, metadata_revision=?3 WHERE id=?1",
                            params![project.id, name, revision],
                        )?;
                    }
                    Edit::Icon(icon) => {
                        let encoded = icon.as_ref().map(serde_json::to_string).transpose()?;
                        tx.execute(
                            "UPDATE projects SET project_icon=?2, favicon_path=NULL, metadata_revision=?3 WHERE id=?1",
                            params![project.id, encoded, revision],
                        )?;
                    }
                }
            }
            selected
                .iter()
                .map(|project| Ok(tx.query_row(
                    "SELECT * FROM projects WHERE id=?1",
                    [&project.id],
                    project_row,
                )?))
                .collect()
        })
    }
}
