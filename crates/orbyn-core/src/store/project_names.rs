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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_history_is_bounded_saturating_and_cascades_with_its_project() {
        let root = std::env::temp_dir().join(crate::util::new_id());
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("test.sqlite3"), "test").unwrap();
        let project = store
            .add_project(super::super::NewProject {
                path: "/history",
                name: "History",
                is_git: false,
                managed: false,
                scratch: false,
            })
            .unwrap();
        store.commit(|tx,_| {
            for n in 0..260 { remember_image(tx,&project.id,&format!("{n}.png"))?; }
            tx.execute("UPDATE project_image_history SET selection_count=9223372036854775807 WHERE project_id=?1 AND path='259.png'", [&project.id])?;
            remember_image(tx,&project.id,"259.png")?;
            Ok(())
        }).unwrap();
        let history = store.project_image_history(&project.id).unwrap();
        assert_eq!(history.len(), 256);
        assert!(!history.contains_key("0.png"));
        assert_eq!(history["259.png"].0, i64::MAX);
        store.delete_project(&project.id).unwrap();
        assert!(store.project_image_history(&project.id).unwrap().is_empty());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[derive(Clone, Copy)]
enum Edit<'a> {
    Name(&'a str),
    Icon(&'a Option<ProjectIconOverride>),
    Image(&'a str),
}

fn remember_image(tx: &rusqlite::Transaction<'_>, id: &str, path: &str) -> Result<()> {
    let last_used = time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .clamp(0, i64::MAX as i128) as i64;
    tx.execute("INSERT INTO project_image_history(project_id,path,selection_count,last_used) VALUES(?1,?2,1,?3) ON CONFLICT(project_id,path) DO UPDATE SET selection_count=MIN(selection_count,9223372036854775806)+1,last_used=excluded.last_used", params![id,path,last_used])?;
    tx.execute("DELETE FROM project_image_history WHERE project_id=?1 AND path NOT IN (SELECT path FROM project_image_history WHERE project_id=?1 ORDER BY last_used DESC,selection_count DESC,path LIMIT 256)", [id])?;
    Ok(())
}

impl Store {
    pub(crate) fn project_image_history(&self, id: &str) -> Result<BTreeMap<String, (i64, i64)>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT path,selection_count,last_used FROM project_image_history WHERE project_id=?1",
        )?;
        Ok(statement
            .query_map([id], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub(crate) fn change_selected_project_image(
        &self,
        catalog: &ProjectScopeCatalog,
        library_root: &Path,
        expected: &BTreeMap<String, String>,
        path: &str,
    ) -> Result<Vec<Project>> {
        self.edit_project_metadata(
            catalog,
            library_root,
            Expected::Revisions(expected),
            Edit::Image(path),
        )
    }
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
                    Edit::Image(path) => {
                        project.favicon_path = Some(path.to_owned());
                        project.project_icon = None;
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
                    Edit::Image(path) => {
                        tx.execute("UPDATE projects SET favicon_path=?2, project_icon=NULL, metadata_revision=?3 WHERE id=?1", params![project.id,path,revision])?;
                        remember_image(tx, &project.id, path)?;
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
