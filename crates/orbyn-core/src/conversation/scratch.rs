//! Threads with no project. Each gets a dated folder under app data, which stays
//! on disk after the thread goes. Behind it is a hidden project, so a scratch thread
//! passes through the same trust, write scope and launch as any other. Orbyn made
//! the folder, so it starts trusted, and it is never inside the library.

use orbyn_contracts::{CreateThread, Project, Thread};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::NewProject;
use crate::util::new_id;

impl Core {
    pub(crate) fn new_scratch(&self) -> Result<Project> {
        let today = time::OffsetDateTime::now_utc().date();
        let path = self
            .config
            .data_dir
            .join("scratch")
            .join(format!("{today}-{}", new_id()));
        std::fs::create_dir_all(&path)?;
        let real = crate::util::canonicalize(&path)?;
        self.store.add_project(NewProject {
            path: &real.to_string_lossy(),
            name: "Scratch",
            is_git: false,
            managed: true,
            scratch: true,
        })
    }

    /// Moves a thread that has not run yet. No target means a new scratch folder.
    pub fn move_thread(&self, id: &str, project_id: Option<&str>) -> Result<Thread> {
        let target = match project_id {
            Some(project) => self.store.project(project)?,
            None => self.new_scratch()?,
        };
        let thread = self.store.move_thread(id, &target)?;
        self.setups.forget(id);
        self.terminals.close(id);
        self.previews.close_thread(id);
        Ok(thread)
    }

    /// Turns a scratch folder into a project where it is, with every thread in it.
    pub fn adopt_scratch(&self, thread_id: &str, name: Option<&str>) -> Result<Project> {
        let thread = self.store.thread(thread_id)?;
        if !thread.scratch {
            return Err(CoreError::Invalid(
                "This thread already belongs to a project.".into(),
            ));
        }
        let name = name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(thread.title.as_str());
        self.store.adopt_scratch(&thread.project_id, name)
    }

    pub(crate) fn scratch_request(&self, request: &CreateThread) -> Result<Option<Project>> {
        if request.project_id.is_some() {
            return Ok(None);
        }
        if request.worktree.is_some() {
            return Err(CoreError::Invalid(
                "Worktrees need a Git repository.".into(),
            ));
        }
        self.new_scratch().map(Some)
    }
}
