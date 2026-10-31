//! Spawning an engine with piped stdio: bounded line framing and a bounded
//! stderr tail used only for diagnostics.

use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures_util::stream::Stream;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{ChildStdin, ChildStdout};
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};

use crate::error::{CoreError, Result};
use crate::process::{ManagedChild, ResolvedCommand, engine_command, resolve};
use crate::util::tail;

/// One protocol line. Engines can emit whole file contents in a single frame.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 8 * 1024;

pub(crate) struct EngineProcess {
    pub child: ManagedChild,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: StderrTail,
}

#[derive(Clone, Default)]
pub(crate) struct StderrTail(Arc<Mutex<String>>);

impl StderrTail {
    fn start(self, mut stderr: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let tail_buffer = self.0.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut chunk).await {
                if read == 0 {
                    break;
                }
                let mut buffer = tail_buffer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
                if buffer.len() > STDERR_TAIL_BYTES * 2 {
                    *buffer = tail(&buffer, STDERR_TAIL_BYTES);
                }
            }
        });
        self
    }

    pub fn text(&self) -> String {
        let buffer = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tail(&buffer, 1024)
    }
}

pub(crate) fn resolve_engine(program: &str) -> Result<ResolvedCommand> {
    resolve(program).ok_or_else(|| {
        CoreError::EngineUnavailable(format!("{program} was not found on this machine."))
    })
}

pub(crate) fn spawn_engine(
    command: &ResolvedCommand,
    args: &[OsString],
    cwd: &Path,
) -> Result<EngineProcess> {
    let mut child = ManagedChild::spawn(engine_command(command, args, cwd)).map_err(|error| {
        CoreError::EngineUnavailable(format!("Could not start engine: {error}"))
    })?;
    let handle = child.child_mut();
    let missing = || CoreError::Internal("child stdio was not piped".into());
    let stdin = handle.stdin.take().ok_or_else(missing)?;
    let stdout = handle.stdout.take().ok_or_else(missing)?;
    let stderr = handle.stderr.take().ok_or_else(missing)?;
    Ok(EngineProcess {
        child,
        stdin,
        stdout,
        stderr: StderrTail::default().start(stderr),
    })
}

pub(crate) fn lines(
    stdout: ChildStdout,
) -> impl Stream<Item = Result<String, LinesCodecError>> + Unpin {
    FramedRead::new(stdout, LinesCodec::new_with_max_length(MAX_LINE_BYTES))
}

/// Failure text for an engine that ended without finishing its protocol.
pub(crate) fn exit_message(
    status: Option<std::process::ExitStatus>,
    stderr: &StderrTail,
) -> String {
    let code = status.map_or_else(
        || "an unknown status".to_owned(),
        |status| {
            status
                .code()
                .map_or("a signal".to_owned(), |c| format!("code {c}"))
        },
    );
    let detail = stderr.text();
    if detail.is_empty() {
        format!("The engine exited with {code} before finishing.")
    } else {
        format!("The engine exited with {code}: {detail}")
    }
}
