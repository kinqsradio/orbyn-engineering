//! Read-only engine probes. They run version and login status commands from a
//! neutral directory, so no repository config or hooks load, and open no session.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use orbyn_contracts::AuthState;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::super::driver::EngineProbe;
use crate::process::{ResolvedCommand, resolve};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// A status command has no reason to print more than this.
const MAX_CAPTURE: u64 = 256 * 1024;

pub(crate) struct Captured {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a short command and captures its output, or `None` on spawn failure or timeout.
pub(crate) async fn capture(
    command: &ResolvedCommand,
    args: &[&str],
    timeout: Duration,
) -> Option<Captured> {
    let mut builder = Command::new(&command.program);
    builder
        .args(&command.prefix)
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::child_env::for_engine(builder.as_std_mut());
    let mut child = builder.spawn().ok()?;
    let (stdout, stderr) = (child.stdout.take()?, child.stderr.take()?);
    let read = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (mut limited_out, mut limited_err) =
            (stdout.take(MAX_CAPTURE), stderr.take(MAX_CAPTURE));
        let (first, second) = tokio::join!(
            limited_out.read_to_end(&mut out),
            limited_err.read_to_end(&mut err)
        );
        first.ok()?;
        second.ok()?;
        // Past the limit the rest goes unread, so this ends it rather than waiting.
        let status = match child.try_wait().ok()? {
            Some(status) => status,
            None if out.len() as u64 >= MAX_CAPTURE || err.len() as u64 >= MAX_CAPTURE => {
                child.start_kill().ok()?;
                child.wait().await.ok()?
            }
            None => child.wait().await.ok()?,
        };
        Some((status, out, err))
    };
    let (status, out, err) = tokio::time::timeout(timeout, read).await.ok()??;
    Some(Captured {
        status: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
    })
}

pub(crate) async fn probe_cli(program: &str, version_args: &[&str]) -> EngineProbe {
    let Some(command) = resolve(program) else {
        return EngineProbe::default();
    };
    let mut probe = EngineProbe {
        path: Some(command.path.clone()),
        ..EngineProbe::default()
    };
    match capture(&command, version_args, PROBE_TIMEOUT).await {
        Some(output) if output.status == 0 => {
            probe.version = parse_version(&output.stdout);
            if probe.version.is_none() {
                probe.problem = Some("Could not read this engine's version.".into());
            }
        }
        Some(_) => probe.problem = Some("This engine's version command failed.".into()),
        None => probe.problem = Some("This engine did not respond.".into()),
    }
    probe
}

pub(crate) async fn read_login(
    program: &str,
    args: &[&str],
    parse: fn(i32, &str) -> AuthState,
) -> AuthState {
    let Some(command) = resolve(program) else {
        return AuthState::Unknown;
    };
    match capture(&command, args, PROBE_TIMEOUT).await {
        // Some CLIs print their login line on stderr.
        Some(output) => parse(
            output.status,
            &format!("{}{}", output.stdout, output.stderr),
        ),
        None => AuthState::Unknown,
    }
}

/// The first dotted number in a version line, such as `2.1.150 (Claude Code)`
/// or `codex-cli 0.166.0`.
pub fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|word| {
        let word = word.trim_start_matches('v');
        let dotted = word.split('.').count() >= 2
            && word.split('.').all(|part| {
                !part.is_empty() && part.chars().next().is_some_and(|c| c.is_ascii_digit())
            });
        dotted.then(|| word.to_owned())
    })
}

/// The symlink-free path used for ownership checks.
pub(crate) fn real_path(path: &Path) -> PathBuf {
    crate::util::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_real_version_lines() {
        assert_eq!(
            parse_version("2.1.150 (Claude Code)\n").as_deref(),
            Some("2.1.150")
        );
        assert_eq!(
            parse_version("codex-cli 0.166.0\n").as_deref(),
            Some("0.166.0")
        );
        assert_eq!(parse_version("no version here"), None);
    }
}
