//! Child processes as owned resources. Each engine runs in its own process tree
//! and the tree dies with its owner on every exit path. Unix uses a process
//! group; Windows uses a job object with `taskkill /T` as the fallback.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

use crate::error::{CoreError, Result};

/// A program ready to spawn. Windows shims resolve to their real entry point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedCommand {
    pub program: PathBuf,
    pub prefix: Vec<OsString>,
    /// The file found on PATH, before following any shim.
    pub path: PathBuf,
}

/// Resolves a bare name through PATH, or an explicit path as given.
pub fn resolve(name: &str) -> Option<ResolvedCommand> {
    let search = crate::child_env::widened(std::env::var_os("PATH").as_deref());
    let path = find_on_path(name, Some(&search))?;
    shim_target(&path)
}

fn find_on_path(name: &str, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.components().count() > 1 || direct.is_absolute() {
        return candidates(direct).into_iter().find(|path| path.is_file());
    }
    std::env::split_paths(path_var?)
        .flat_map(|dir| candidates(&dir.join(name)))
        .find(|path| is_runnable(path))
}

#[cfg(unix)]
fn candidates(base: &Path) -> Vec<PathBuf> {
    vec![base.to_path_buf()]
}

#[cfg(windows)]
fn candidates(base: &Path) -> Vec<PathBuf> {
    if base.extension().is_some() {
        return vec![base.to_path_buf()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
    pathext
        .split(';')
        .filter(|ext| !ext.is_empty())
        .chain([".ps1"])
        .map(|ext| {
            let mut name = base.as_os_str().to_owned();
            name.push(ext);
            PathBuf::from(name)
        })
        .collect()
}

#[cfg(unix)]
fn is_runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_runnable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(unix)]
fn shim_target(path: &Path) -> Option<ResolvedCommand> {
    Some(ResolvedCommand {
        program: path.to_path_buf(),
        prefix: Vec::new(),
        path: path.to_path_buf(),
    })
}

/// Windows cannot `CreateProcess` a script. An npm `.cmd` shim is followed to
/// the script it wraps, so no argument ever passes through `cmd.exe` parsing;
/// a `.cmd` that cannot be followed is refused rather than quoted by hand.
#[cfg(windows)]
fn shim_target(path: &Path) -> Option<ResolvedCommand> {
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase());
    match extension.as_deref() {
        Some("cmd" | "bat") => {
            let text = std::fs::read_to_string(path).ok()?;
            let script = match parse_cmd_shim(&text) {
                Some(script) => path.parent()?.join(script),
                None => sibling_script(path)?,
            };
            if script
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                return Some(ResolvedCommand {
                    program: script,
                    prefix: Vec::new(),
                    path: path.to_path_buf(),
                });
            }
            let beside = path.parent()?.join("node.exe");
            let node = if beside.is_file() {
                beside
            } else {
                let search = crate::child_env::widened(std::env::var_os("PATH").as_deref());
                find_on_path("node", Some(&search))?
            };
            Some(ResolvedCommand {
                program: node,
                prefix: vec![script.into_os_string()],
                path: path.to_path_buf(),
            })
        }
        Some("ps1") => Some(ResolvedCommand {
            program: PathBuf::from("powershell.exe"),
            prefix: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
            .iter()
            .map(OsString::from)
            .chain([path.as_os_str().to_owned()])
            .collect(),
            path: path.to_path_buf(),
        }),
        _ => Some(ResolvedCommand {
            program: path.to_path_buf(),
            prefix: Vec::new(),
            path: path.to_path_buf(),
        }),
    }
}

/// A standalone installer can put its launcher beside the `.cmd` under the same name.
#[cfg(windows)]
fn sibling_script(shim: &Path) -> Option<PathBuf> {
    ["js", "cjs", "mjs"]
        .iter()
        .map(|extension| shim.with_extension(extension))
        .find(|script| script.is_file())
}

/// A shim that hands off to a shell would put arguments back through its parser,
/// which is what following a shim exists to avoid.
fn is_shell_host(file: &str) -> bool {
    let name = file.rsplit(['\\', '/']).next().unwrap_or(file);
    let name = name.to_ascii_lowercase();
    let Some(stem) = name.strip_suffix(".exe") else {
        return false;
    };
    [
        "cmd",
        "powershell",
        "pwsh",
        "wscript",
        "cscript",
        "bash",
        "sh",
        "mshta",
    ]
    .contains(&stem)
}

/// Finds the wrapped script in an npm-style `.cmd` shim: the first quoted
/// `%dp0%\...` or `%~dp0\...` path. The result is relative to the shim's folder.
/// npm and pnpm both write this shape; pnpm's path climbs into its store.
pub fn parse_cmd_shim(text: &str) -> Option<String> {
    for marker in ["\"%dp0%\\", "\"%~dp0\\", "\"%dp0%/", "\"%~dp0/"] {
        for (start, _) in text.match_indices(marker) {
            let rest = &text[start + marker.len()..];
            let end = rest.find('"')?;
            let candidate = &rest[..end];
            let lower = candidate.to_ascii_lowercase();
            if [".js", ".cjs", ".mjs", ".exe"]
                .iter()
                .any(|ext| lower.ends_with(ext))
                && !lower.ends_with("node.exe")
                && !is_shell_host(&lower)
            {
                return Some(candidate.replace('\\', std::path::MAIN_SEPARATOR_STR));
            }
        }
    }
    None
}

/// Builds a piped command in its own process tree.
pub fn engine_command(command: &ResolvedCommand, args: &[OsString], cwd: &Path) -> Command {
    let mut builder = Command::new(&command.program);
    builder
        .args(&command.prefix)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::child_env::for_engine(builder.as_std_mut());
    isolate(&mut builder);
    builder
}

#[cfg(unix)]
fn isolate(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
fn isolate(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Owns a spawned child. Dropping it kills the whole tree.
pub struct ManagedChild {
    child: Child,
    tree: ProcessTree,
}

impl ManagedChild {
    pub fn spawn(mut command: Command) -> Result<Self> {
        let child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| CoreError::Internal("child exited before it had a pid".into()))?;
        let tree = ProcessTree::attach(&child, pid);
        Ok(Self { child, tree })
    }

    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    /// Asks the tree to stop. Windows has no such signal, so callers use the
    /// engine's own protocol first and this is a forced stop there.
    pub fn terminate(&self) {
        self.tree.terminate();
    }

    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.tree.kill();
    }
}

#[cfg(unix)]
pub struct ProcessTree {
    leader: i32,
}

#[cfg(unix)]
impl ProcessTree {
    fn attach(_child: &Child, pid: u32) -> Self {
        Self::from_group(pid as i32)
    }

    /// `leader` must lead its own process group.
    pub fn from_group(leader: i32) -> Self {
        Self { leader }
    }

    pub fn terminate(&self) {
        self.signal(libc::SIGTERM);
    }

    pub fn kill(&self) {
        self.signal(libc::SIGKILL);
    }

    fn signal(&self, signal: i32) {
        if self.leader <= 1 {
            return;
        }
        // SAFETY: `kill` takes plain integers and touches no memory. A negative
        // pid addresses the group this type owns; ESRCH after exit is harmless.
        unsafe {
            libc::kill(-self.leader, signal);
        }
    }
}

#[cfg(windows)]
pub struct ProcessTree {
    pid: u32,
    job: Option<windows_job::Job>,
}

#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child, pid: u32) -> Self {
        let job = child.raw_handle().and_then(windows_job::Job::assign);
        Self { pid, job }
    }

    pub fn from_pid(pid: u32) -> Self {
        Self { pid, job: None }
    }

    pub fn terminate(&self) {
        self.kill();
    }

    pub fn kill(&self) {
        if let Some(job) = &self.job {
            job.terminate();
            return;
        }
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &self.pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };

    /// A kill-on-close job that contains one engine's process tree.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a process-wide kernel handle with no thread
    // affinity, and it is closed exactly once in `Drop`.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn assign(process: std::os::windows::io::RawHandle) -> Option<Self> {
            // SAFETY: all pointers are valid for the duration of each call,
            // `info` is the structure the information class names, and
            // `process` is a live handle owned by the caller's `Child`.
            unsafe {
                let job = CreateJobObjectW(null(), null());
                if job.is_null() {
                    return None;
                }
                let guard = Self(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let limited = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if limited == 0 || AssignProcessToJobObject(job, process.cast()) == 0 {
                    return None;
                }
                Some(guard)
            }
        }

        pub fn terminate(&self) {
            // SAFETY: the handle stays open for the life of `self`.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: this type owns the handle and closes it once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pnpm_shim_is_followed_into_its_store() {
        let shim = "@SETLOCAL\r\n\"%~dp0\\node.exe\" \"%~dp0\\..\\.pnpm\\tool@1\\node_modules\\tool\\cli.mjs\" %*\r\n";
        let script = parse_cmd_shim(shim).unwrap();
        assert!(script.ends_with("cli.mjs"), "{script}");
    }

    #[test]
    fn a_shim_that_hands_off_to_a_shell_is_refused() {
        for shim in [
            "\"%dp0%\\cmd.exe\" /c evil %*",
            "\"%~dp0\\powershell.exe\" -File x %*",
            "\"%dp0%\\sub\\PWSH.EXE\" %*",
        ] {
            assert_eq!(parse_cmd_shim(shim), None, "{shim}");
        }
    }

    #[test]
    fn follows_npm_cmd_shim_to_its_script() {
        let shim = "@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        let expected = ["node_modules", "@openai", "codex", "bin", "codex.js"]
            .join(std::path::MAIN_SEPARATOR_STR);
        assert_eq!(parse_cmd_shim(shim), Some(expected));
    }

    #[test]
    fn unfollowable_shim_is_refused() {
        assert_eq!(parse_cmd_shim("@echo off\r\nsomething.exe %*\r\n"), None);
    }

    #[test]
    fn finds_on_explicit_path_only_when_runnable() {
        let dir = crate::testing::TempDir::new();
        assert!(find_on_path("no-such-tool-xyz", Some(dir.path().as_os_str())).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_the_owner_kills_descendants() {
        let dir = crate::testing::TempDir::new();
        let pid_file = dir.path().join("pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let command = ResolvedCommand {
            program: "/bin/sh".into(),
            prefix: Vec::new(),
            path: "/bin/sh".into(),
        };
        let child = ManagedChild::spawn(engine_command(
            &command,
            &["-c".into(), script.into()],
            dir.path(),
        ))
        .unwrap();
        let grandchild: i32 = loop {
            if let Ok(text) = std::fs::read_to_string(&pid_file)
                && let Ok(pid) = text.trim().parse()
            {
                break pid;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        drop(child);
        for _ in 0..200 {
            // SAFETY: signal 0 only probes for existence.
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("grandchild survived its owner");
    }
}
