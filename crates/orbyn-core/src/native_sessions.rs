//! Management of an agent's own saved conversations: list, import as a thread, delete.
//! The service picks the launch folder from the registered project. Whatever the
//! agent reports about folders is shown as data and never widens access.
use std::path::Path;

use orbyn_contracts::{
    AcpNativeSession, AcpNativeSessionImported, AcpNativeSessionPage, AcpNativeSessionsQuery,
    AcpSessionCapabilities, DeleteAcpNativeSession, ImportAcpNativeSession, Project,
};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::NewThread;

/// Pages scanned to confirm that a session belongs to the project, so a stray
/// identifier can neither be imported nor deleted.
const MAX_PAGES: usize = 20;
const MAX_TITLE: usize = 120;

impl Core {
    /// What the instance offers, read without signing in.
    pub async fn native_session_capabilities(
        &self,
        engine: &str,
    ) -> Result<AcpSessionCapabilities> {
        self.engines.check_enabled(engine)?;
        let _operation = self.engines.begin_native_operation(engine)?;
        self.engines
            .driver(engine)?
            .native_session_capabilities()
            .await?
            .ok_or_else(|| unsupported("manage native sessions"))
    }

    pub async fn list_native_sessions(
        &self,
        engine: &str,
        query: &AcpNativeSessionsQuery,
    ) -> Result<AcpNativeSessionPage> {
        let project = self.native_project(engine, &query.project_id)?;
        let _operation = self.engines.begin_native_operation(engine)?;
        let driver = self.engines.driver(engine)?;
        let mut page = driver
            .list_native_sessions(Path::new(&project.path), query.cursor.as_deref())
            .await?;
        for session in &mut page.sessions {
            session.imported_thread_id =
                self.store
                    .thread_for_native_session(engine, &project.id, &session.session_id)?;
        }
        Ok(page)
    }

    pub async fn import_native_session(
        &self,
        engine: &str,
        request: &ImportAcpNativeSession,
    ) -> Result<AcpNativeSessionImported> {
        let project = self.native_project(engine, &request.project_id)?;
        let _operation = self.engines.begin_native_operation(engine)?;
        let driver = self.engines.driver(engine)?;
        let caps = driver
            .native_session_capabilities()
            .await?
            .ok_or_else(|| unsupported("import native sessions"))?;
        if !caps.can_load && !caps.can_resume {
            return Err(unsupported("import native sessions"));
        }
        if let Some(thread_id) =
            self.store
                .thread_for_native_session(engine, &project.id, &request.session_id)?
        {
            return Ok(AcpNativeSessionImported {
                thread_id,
                imported: false,
            });
        }
        let listed = find_session(&*driver, &project, &request.session_id).await?;
        let replay = driver
            .load_native_session(Path::new(&project.path), &request.session_id)
            .await?;
        let title = title_of(
            listed.title.as_deref().or(request.title.as_deref()),
            &request.session_id,
        );
        let (thread, imported) = self.store.import_native_thread(
            NewThread {
                project_id: project.id.clone(),
                title,
                engine: engine.to_owned(),
                model: None,
                cwd: project.path.clone(),
                worktree: None,
                skill_profile: None,
                parent_thread_id: None,
                relation: None,
                scratch: project.scratch,
            },
            &request.session_id,
            &replay.events,
        )?;
        Ok(AcpNativeSessionImported {
            thread_id: thread.id,
            imported,
        })
    }

    pub async fn delete_native_session(
        &self,
        engine: &str,
        request: &DeleteAcpNativeSession,
    ) -> Result<()> {
        let project = self.native_project(engine, &request.project_id)?;
        let _operation = self.engines.begin_native_operation(engine)?;
        if self
            .store
            .native_session_in_use(engine, &request.session_id)?
        {
            return Err(CoreError::Invalid(
                "Delete the thread that holds this session first.".into(),
            ));
        }
        let driver = self.engines.driver(engine)?;
        find_session(&*driver, &project, &request.session_id).await?;
        driver
            .delete_native_session(Path::new(&project.path), &request.session_id)
            .await
    }

    /// The registered, trusted project for which the instance is turned on.
    fn native_project(&self, engine: &str, project_id: &str) -> Result<Project> {
        self.workspace.root()?;
        let project = self.store.project(project_id)?;
        if !project.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        self.check_engine_enabled(engine, &project.id)?;
        Ok(project)
    }
}

async fn find_session(
    driver: &dyn crate::driver::EngineDriver,
    project: &Project,
    session: &str,
) -> Result<AcpNativeSession> {
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = driver
            .list_native_sessions(Path::new(&project.path), cursor.as_deref())
            .await?;
        if let Some(found) = page.sessions.into_iter().find(|s| s.session_id == session) {
            return Ok(found);
        }
        match page.next_cursor {
            Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
            _ => break,
        }
    }
    Err(CoreError::NotFound("native session".into()))
}

fn title_of(title: Option<&str>, session: &str) -> String {
    let text = title.map(str::trim).filter(|t| !t.is_empty());
    let text = text.unwrap_or(session);
    text.chars().take(MAX_TITLE).collect()
}

fn unsupported(what: &str) -> CoreError {
    CoreError::Unsupported(format!("This engine cannot {what}."))
}
