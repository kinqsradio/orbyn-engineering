//! The engine's own console, resumed on a thread's session in an Orbyn terminal.
//!
//! The engine's unmodified CLI runs with its own login and its own permission
//! prompts. Orbyn passes the session, model and plan mode as arguments, never
//! through a shell, and reads nothing the console writes. While the console is
//! alive it owns the session, so the thread admits no run until it exits.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use orbyn_contracts::TerminalInfo;
use serde_json::json;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::host::terminal::{PtySpec, TerminalLabel, TerminalManager};
use crate::store::AuditRecord;

/// The one console terminal a thread can have.
pub const CONSOLE_TERMINAL: &str = "engine-console";

/// What a driver needs to resume its session as a person would.
pub struct ConsoleSpec<'a> {
    pub session: &'a str,
    pub model: Option<&'a str>,
    pub plan: bool,
    /// Where Orbyn starts this engine's runs, the library for a native engine.
    pub root: &'a Path,
    /// The thread's checkout, the same as `root` on a library thread.
    pub checkout: &'a Path,
}

/// The engine's program, its arguments and the folder it starts in.
pub struct ConsoleCommand {
    pub program: String,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub title: String,
}

/// True while the thread's console process is running.
pub fn console_alive(terminals: &TerminalManager, thread_id: &str) -> bool {
    terminals
        .named(thread_id, CONSOLE_TERMINAL)
        .is_some_and(|session| session.is_alive())
}

/// An argument an engine could read as a flag is refused rather than passed.
fn plain(value: &str, what: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(CoreError::Invalid(format!(
            "This thread's {what} cannot be passed to the engine's console."
        )));
    }
    Ok(())
}

impl Core {
    /// Opens, or returns the live, console of the thread's engine on its session.
    pub async fn open_engine_console(
        &self,
        thread_id: &str,
        (cols, rows): (u16, u16),
        actor: &str,
    ) -> Result<TerminalInfo> {
        let thread = self.store.thread(thread_id)?;
        if let Some(info) = self.live_console(thread_id) {
            return Ok(info);
        }
        let driver = self.engines.driver(&thread.engine)?;
        let name = driver.descriptor().name;
        let session = self.store.engine_session(thread_id)?.ok_or_else(|| {
            CoreError::Unsupported(format!(
                "This thread has no {name} session yet. Send a message first."
            ))
        })?;
        plain(&session, "session")?;
        if let Some(model) = &thread.model {
            plain(model, "model")?;
        }
        let root = self.workspace.root()?;
        let checkout = if Path::new(&thread.cwd) == root {
            root.clone()
        } else {
            crate::project::workspace::check_target(&root, Path::new(&thread.cwd)).await?
        };
        let console = driver
            .console(&ConsoleSpec {
                session: &session,
                model: thread.model.as_deref(),
                plan: thread.lifecycle.as_ref().is_some_and(|l| l.plan_mode),
                root: &root,
                checkout: &checkout,
            })
            .ok_or_else(|| {
                CoreError::Unsupported(format!("{name} has no console Orbyn can resume."))
            })?;
        let command = crate::host::process::resolve(&console.program).ok_or_else(|| {
            CoreError::EngineUnavailable(format!(
                "{} was not found on this machine.",
                console.program
            ))
        })?;
        let mut args = command.prefix.clone();
        args.extend(console.args);
        // The admission lock: a run admitted now sees this console, and a run
        // admitted first is seen here.
        self.workspace.admit_with(|| {
            if self.store.thread(thread_id)?.active_run.is_some() {
                return Err(CoreError::ThreadBusy);
            }
            if let Some(info) = self.live_console(thread_id) {
                return Ok(info);
            }
            self.store.append_audit(&AuditRecord {
                actor: actor.to_owned(),
                action: "engine.console".into(),
                target: console.cwd.to_string_lossy().into_owned(),
                decision: None,
                source: "user".into(),
                thread_id: Some(thread_id.to_owned()),
                run_id: None,
                detail: json!({ "engine": thread.engine, "session": session }),
            })?;
            self.terminals.open_named(
                thread_id,
                CONSOLE_TERMINAL,
                TerminalLabel {
                    title: Some(console.title.clone()),
                    ..TerminalLabel::default()
                },
                PtySpec {
                    program: command.program.clone(),
                    args: args.clone(),
                    cwd: console.cwd.clone(),
                    cols,
                    rows,
                    engine: true,
                },
            )
        })
    }

    fn live_console(&self, thread_id: &str) -> Option<TerminalInfo> {
        if !console_alive(&self.terminals, thread_id) {
            return None;
        }
        self.terminals
            .list(thread_id)
            .into_iter()
            .find(|info| info.id == CONSOLE_TERMINAL)
    }
}
