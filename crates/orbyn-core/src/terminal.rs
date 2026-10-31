//! PTY sessions, any number per thread. portable-pty uses ConPTY on Windows.
//! Output is broadcast to any attached client and kept in a bounded scrollback,
//! so a reconnecting client sees recent output. A thread's `main` terminal is the
//! one a plain socket opens; the others are named by the client.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use orbyn_contracts::TerminalInfo;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, watch};

use crate::error::{CoreError, Result};
use crate::process::ProcessTree;

const SCROLLBACK_BYTES: usize = 8 * 1024 * 1024;
const SCROLLBACK_LINES: usize = 5_000;
const MAX_TERMINALS: usize = 32;

/// The terminal a thread's plain socket and a terminal-tier run use.
pub const MAIN_TERMINAL: &str = "main";

/// Recent output, cut at whichever of the byte and line limits comes first.
#[derive(Default)]
struct Scrollback {
    bytes: VecDeque<u8>,
    lines: usize,
}

impl Scrollback {
    fn push(&mut self, chunk: &[u8], max_bytes: usize, max_lines: usize) {
        self.bytes.extend(chunk.iter().copied());
        self.lines += chunk.iter().filter(|byte| **byte == b'\n').count();
        let overflow = self.bytes.len().saturating_sub(max_bytes);
        let cut: Vec<u8> = self.bytes.drain(..overflow).collect();
        self.lines -= cut.iter().filter(|byte| **byte == b'\n').count();
        while self.lines > max_lines {
            let Some(end) = self.bytes.iter().position(|byte| *byte == b'\n') else {
                break;
            };
            self.bytes.drain(..=end);
            self.lines -= 1;
        }
    }
}

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
    scrollback: Mutex<Scrollback>,
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
        (scrollback.bytes.iter().copied().collect(), receiver)
    }

    pub fn scrollback(&self) -> Vec<u8> {
        lock(&self.scrollback).bytes.iter().copied().collect()
    }

    pub fn clear(&self) {
        *lock(&self.scrollback) = Scrollback::default();
    }

    pub fn exit_code(&self) -> Option<i32> {
        *self.exit.borrow()
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

/// The tree goes first: this runs before the fields drop, and closing a pseudo console
/// can block on a survivor still holding its output pipe.
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

struct Entry {
    info: TerminalInfo,
    session: Arc<PtySession>,
}

type Key = (String, String);

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<Key, Entry>>,
}

/// What a new terminal is called and where it sits.
#[derive(Clone, Debug, Default)]
pub struct TerminalLabel {
    pub title: Option<String>,
    pub group: Option<String>,
    pub direction: Option<String>,
    pub script: Option<String>,
}

fn key(thread_id: &str, id: &str) -> Key {
    (thread_id.to_owned(), id.to_owned())
}

fn current(entry: &Entry) -> TerminalInfo {
    TerminalInfo {
        alive: entry.session.is_alive(),
        exit_code: entry.session.exit_code(),
        clients: entry.session.attached_clients(),
        ..entry.info.clone()
    }
}

impl TerminalManager {
    /// Returns the thread's live main terminal, or starts one from `spec`.
    pub fn open(&self, thread_id: &str, spec: PtySpec) -> Result<Arc<PtySession>> {
        let mut sessions = lock(&self.sessions);
        if let Some(existing) = sessions
            .get(&key(thread_id, MAIN_TERMINAL))
            .filter(|entry| entry.session.is_alive())
        {
            return Ok(existing.session.clone());
        }
        let label = TerminalLabel {
            title: Some("Terminal".to_owned()),
            ..TerminalLabel::default()
        };
        let session = spawn(spec)?;
        insert(
            &mut sessions,
            thread_id,
            MAIN_TERMINAL,
            label,
            session.clone(),
        );
        Ok(session)
    }

    /// Starts another terminal on this thread, replacing an ended one of that id.
    pub fn open_named(
        &self,
        thread_id: &str,
        id: &str,
        label: TerminalLabel,
        spec: PtySpec,
    ) -> Result<TerminalInfo> {
        let mut sessions = lock(&self.sessions);
        let open = sessions
            .keys()
            .filter(|(owner, _)| owner == thread_id)
            .count();
        if open >= MAX_TERMINALS {
            return Err(CoreError::Invalid(format!(
                "A thread can hold {MAX_TERMINALS} terminals."
            )));
        }
        if let Some(entry) = sessions.remove(&key(thread_id, id)) {
            entry.session.kill();
        }
        let session = spawn(spec)?;
        let info = insert(&mut sessions, thread_id, id, label, session);
        Ok(info)
    }

    /// The live main terminal for a thread, if any.
    pub fn session(&self, thread_id: &str) -> Option<Arc<PtySession>> {
        self.named(thread_id, MAIN_TERMINAL)
            .filter(|session| session.is_alive())
    }

    /// A terminal by id, ended or not, so its last output can still be read.
    pub fn named(&self, thread_id: &str, id: &str) -> Option<Arc<PtySession>> {
        lock(&self.sessions)
            .get(&key(thread_id, id))
            .map(|entry| entry.session.clone())
    }

    /// The group a terminal belongs to, so a split can join it.
    pub fn group_of(&self, thread_id: &str, id: &str) -> Option<String> {
        lock(&self.sessions)
            .get(&key(thread_id, id))
            .map(|entry| entry.info.group.clone())
    }

    pub fn list(&self, thread_id: &str) -> Vec<TerminalInfo> {
        let sessions = lock(&self.sessions);
        let mut list: Vec<TerminalInfo> = sessions
            .iter()
            .filter(|((owner, _), _)| owner == thread_id)
            .map(|(_, entry)| current(entry))
            .collect();
        list.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        list
    }

    pub fn rename(&self, thread_id: &str, id: &str, title: &str) -> Result<TerminalInfo> {
        let mut sessions = lock(&self.sessions);
        let entry = sessions
            .get_mut(&key(thread_id, id))
            .ok_or_else(|| CoreError::NotFound("terminal".into()))?;
        title.clone_into(&mut entry.info.title);
        Ok(current(entry))
    }

    pub fn close_one(&self, thread_id: &str, id: &str) -> Result<()> {
        let entry = lock(&self.sessions)
            .remove(&key(thread_id, id))
            .ok_or_else(|| CoreError::NotFound("terminal".into()))?;
        entry.session.kill();
        Ok(())
    }

    /// Closes every terminal of a thread.
    pub fn close(&self, thread_id: &str) {
        lock(&self.sessions).retain(|(owner, _), entry| {
            let keep = owner != thread_id;
            if !keep {
                entry.session.kill();
            }
            keep
        });
    }

    /// Terminals still running, on every thread.
    pub fn count(&self) -> usize {
        lock(&self.sessions)
            .values()
            .filter(|entry| entry.session.is_alive())
            .count()
    }

    pub fn close_all(&self) {
        for (_, entry) in lock(&self.sessions).drain() {
            entry.session.kill();
        }
    }
}

fn insert(
    sessions: &mut HashMap<Key, Entry>,
    thread_id: &str,
    id: &str,
    label: TerminalLabel,
    session: Arc<PtySession>,
) -> TerminalInfo {
    let info = TerminalInfo {
        id: id.to_owned(),
        thread_id: thread_id.to_owned(),
        title: label.title.unwrap_or_else(|| "Terminal".to_owned()),
        group: label.group.unwrap_or_else(|| id.to_owned()),
        direction: label.direction,
        alive: true,
        exit_code: None,
        clients: 0,
        script: label.script,
        created_at: crate::util::now(),
    };
    let entry = Entry { info, session };
    let shown = current(&entry);
    sessions.insert(key(thread_id, id), entry);
    shown
}

/// Fish asks the terminal questions at startup, and waits on the replies.
fn fish_features(program: &std::path::Path) -> Option<String> {
    if program.file_stem().and_then(|name| name.to_str()) != Some("fish") {
        return None;
    }
    Some(std::env::var("fish_features").map_or_else(
        |_| "no-query-term".to_owned(),
        |existing| format!("{existing},no-query-term"),
    ))
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
    if let Some(features) = fish_features(&spec.program) {
        command.env("fish_features", features);
    }
    let inherited = crate::child_env::for_terminal();
    for name in &inherited.remove {
        command.env_remove(name);
    }
    for (name, value) in &inherited.set {
        command.env(name, value);
    }
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
        scrollback: Mutex::new(Scrollback::default()),
        exit,
        tree: tree_for(pid),
    });
    // PTY reads block, and a blocking thread must not hold a strong reference
    // or the session would never drop.
    let reading = Arc::downgrade(&session);
    std::thread::spawn(move || {
        let mut awaiting_cursor_query = cfg!(windows);
        let mut buffer = [0u8; 8192];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let Some(session) = reading.upgrade() else {
                break;
            };
            let mut chunk = buffer[..read].to_vec();
            if awaiting_cursor_query && take_cursor_query(&mut chunk) {
                awaiting_cursor_query = false;
                let _ = session.write(CURSOR_REPLY);
            }
            let mut scrollback = lock(&session.scrollback);
            scrollback.push(&chunk, SCROLLBACK_BYTES, SCROLLBACK_LINES);
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

/// ConPTY asks where the cursor is before it starts the child, and the child gets
/// nothing until it hears back. A person's terminal might answer, but an engine run
/// has no terminal attached, so the session answers and the question goes no further.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

fn take_cursor_query(chunk: &mut Vec<u8>) -> bool {
    let found = chunk
        .windows(CURSOR_QUERY.len())
        .position(|part| part == CURSOR_QUERY);
    if let Some(at) = found {
        chunk.drain(at..at + CURSOR_QUERY.len());
    }
    found.is_some()
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
        let found = |name: &str| crate::process::resolve(name).map(|command| command.path);
        windows_shell(found, std::env::var_os("COMSPEC"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL").map_or_else(|| "/bin/sh".into(), PathBuf::from)
    }
}

/// PowerShell if a native one is installed, then `ComSpec`. `SHELL` plays no part: Git
/// Bash exports a POSIX path there that a pseudo console cannot start.
pub fn windows_shell(
    find: impl Fn(&str) -> Option<PathBuf>,
    comspec: Option<std::ffi::OsString>,
) -> PathBuf {
    let native = |path: &PathBuf| {
        path.extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com"))
    };
    ["pwsh", "powershell"]
        .iter()
        .find_map(|name| find(name).filter(native))
        .or_else(|| comspec.map(PathBuf::from))
        .unwrap_or_else(|| "cmd.exe".into())
}

/// The shell invocation that runs one command line. Windows stays on `cmd /C`, whose
/// rules a project's scripts are written for, whatever a terminal opens in.
pub fn shell_command(command: &str) -> (PathBuf, Vec<std::ffi::OsString>) {
    #[cfg(windows)]
    let (shell, args) = (
        std::env::var_os("COMSPEC").map_or_else(|| "cmd.exe".into(), PathBuf::from),
        vec!["/C".into(), command.into()],
    );
    #[cfg(not(windows))]
    let (shell, args) = (default_shell(), vec!["-lc".into(), command.into()]);
    (shell, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_query_is_taken_once_and_the_rest_of_the_output_stays() {
        let mut chunk = b"\x1b[?9001h\x1b[6nready".to_vec();
        assert!(take_cursor_query(&mut chunk));
        assert_eq!(chunk, b"\x1b[?9001hready");
        assert!(!take_cursor_query(&mut chunk));
        assert_eq!(chunk, b"\x1b[?9001hready");
    }

    #[test]
    fn windows_prefers_a_native_powershell_and_never_a_script_or_posix_path() {
        let comspec = || Some("C:\\Windows\\cmd.exe".into());
        let installed = |pwsh: Option<&str>, windows: Option<&str>| {
            let (pwsh, windows) = (pwsh.map(PathBuf::from), windows.map(PathBuf::from));
            move |name: &str| {
                if name == "pwsh" {
                    pwsh.clone()
                } else {
                    windows.clone()
                }
            }
        };
        assert_eq!(
            windows_shell(
                installed(Some("C:/p/pwsh.exe"), Some("C:/w/powershell.exe")),
                comspec()
            ),
            PathBuf::from("C:/p/pwsh.exe")
        );
        assert_eq!(
            windows_shell(
                installed(Some("C:/p/pwsh.cmd"), Some("C:/w/powershell.exe")),
                comspec()
            ),
            PathBuf::from("C:/w/powershell.exe"),
            "a shim is not a shell"
        );
        assert_eq!(
            windows_shell(installed(None, None), comspec()),
            PathBuf::from("C:\\Windows\\cmd.exe")
        );
        assert_eq!(
            windows_shell(installed(None, None), None),
            PathBuf::from("cmd.exe")
        );
    }

    #[test]
    fn scrollback_is_cut_at_lines_and_at_bytes() {
        let mut back = Scrollback::default();
        back.push(b"one\ntwo\nthree\n", 100, 2);
        assert_eq!(
            back.bytes.iter().copied().collect::<Vec<u8>>(),
            b"two\nthree\n"
        );
        assert_eq!(back.lines, 2);
        let mut back = Scrollback::default();
        back.push(b"aaaa\nbbbb\n", 6, 100);
        assert_eq!(back.bytes.iter().copied().collect::<Vec<u8>>(), b"\nbbbb\n");
        assert_eq!(back.lines, 2);
    }

    #[test]
    fn only_fish_gets_the_startup_flag() {
        assert!(fish_features(std::path::Path::new("/bin/zsh")).is_none());
        let flag = fish_features(std::path::Path::new("/usr/bin/fish")).unwrap();
        assert!(flag.ends_with("no-query-term"));
    }
}
