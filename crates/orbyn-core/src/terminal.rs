//! PTY sessions, one per thread at most. portable-pty uses ConPTY on Windows.
//! Output is broadcast to any attached client and kept in a bounded scrollback,
//! so a reconnecting client sees recent output.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, watch};

use crate::error::{CoreError, Result};
use crate::process::ProcessTree;

const SCROLLBACK_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub struct PtySpec {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

pub struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    output: broadcast::Sender<Vec<u8>>,
    scrollback: Mutex<VecDeque<u8>>,
    exit: watch::Sender<Option<i32>>,
    tree: ProcessTree,
}

impl PtySession {
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut writer = lock(&self.writer);
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        lock(&self.master)
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| CoreError::Internal(format!("resize failed: {error}")))
    }

    /// Recent output plus a receiver for everything after it. Taken under the
    /// scrollback lock so nothing falls between the two.
    pub fn attach(&self) -> (Vec<u8>, broadcast::Receiver<Vec<u8>>) {
        let scrollback = lock(&self.scrollback);
        let receiver = self.output.subscribe();
        (scrollback.iter().copied().collect(), receiver)
    }

    pub fn exited(&self) -> watch::Receiver<Option<i32>> {
        self.exit.subscribe()
    }

    pub fn attached_clients(&self) -> usize {
        self.output.receiver_count()
    }

    pub fn is_alive(&self) -> bool {
        self.exit.borrow().is_none()
    }

    pub fn kill(&self) {
        self.tree.kill();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.tree.kill();
    }
}

fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl TerminalManager {
    /// Returns the thread's live session, or starts one from `spec`.
    pub fn open(&self, thread_id: &str, spec: PtySpec) -> Result<Arc<PtySession>> {
        let mut sessions = lock(&self.sessions);
        if let Some(existing) = sessions.get(thread_id).filter(|s| s.is_alive()) {
            return Ok(existing.clone());
        }
        let session = spawn(spec)?;
        sessions.insert(thread_id.to_owned(), session.clone());
        Ok(session)
    }

    /// The live session for a thread, if any.
    pub fn session(&self, thread_id: &str) -> Option<Arc<PtySession>> {
        lock(&self.sessions)
            .get(thread_id)
            .filter(|session| session.is_alive())
            .cloned()
    }

    pub fn close(&self, thread_id: &str) {
        if let Some(session) = lock(&self.sessions).remove(thread_id) {
            session.kill();
        }
    }

    pub fn close_all(&self) {
        for (_, session) in lock(&self.sessions).drain() {
            session.kill();
        }
    }
}

fn spawn(spec: PtySpec) -> Result<Arc<PtySession>> {
    fn failed(error: impl std::fmt::Display) -> CoreError {
        CoreError::Internal(format!("PTY failed: {error}"))
    }
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows.max(1),
            cols: spec.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(failed)?;
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.cwd(&spec.cwd);
    let mut child = pty.slave.spawn_command(command).map_err(failed)?;
    drop(pty.slave);
    let pid = child.process_id().unwrap_or(0);
    let mut reader = pty.master.try_clone_reader().map_err(failed)?;
    let writer = pty.master.take_writer().map_err(failed)?;
    let (output, _) = broadcast::channel(256);
    let (exit, _) = watch::channel(None);
    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pty.master),
        output,
        scrollback: Mutex::new(VecDeque::with_capacity(SCROLLBACK_BYTES)),
        exit,
        tree: tree_for(pid),
    });
    // PTY reads block, and a blocking thread must not hold a strong reference
    // or the session would never drop.
    let reading = Arc::downgrade(&session);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let Some(session) = reading.upgrade() else {
                break;
            };
            let chunk = buffer[..read].to_vec();
            let mut scrollback = lock(&session.scrollback);
            let overflow = (scrollback.len() + read).saturating_sub(SCROLLBACK_BYTES);
            let dropped = overflow.min(scrollback.len());
            scrollback.drain(..dropped);
            scrollback.extend(chunk.iter().copied());
            let _ = session.output.send(chunk);
        }
    });
    let waiting = Arc::downgrade(&session);
    std::thread::spawn(move || {
        let code = child
            .wait()
            .ok()
            .map_or(-1, |status| status.exit_code() as i32);
        if let Some(session) = waiting.upgrade() {
            session.exit.send_replace(Some(code));
        }
    });
    Ok(session)
}

#[cfg(unix)]
fn tree_for(pid: u32) -> ProcessTree {
    // portable-pty runs the child through setsid, so it leads its own group.
    ProcessTree::from_group(pid as i32)
}

#[cfg(windows)]
fn tree_for(pid: u32) -> ProcessTree {
    ProcessTree::from_pid(pid)
}

/// Exposed so transport can pick the shell for a plain terminal.
pub fn default_shell() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("COMSPEC").map_or_else(|| "cmd.exe".into(), PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL").map_or_else(|| "/bin/sh".into(), PathBuf::from)
    }
}
