//! Spawning an engine with piped stdio: bounded line framing and a bounded
//! stderr tail used only for diagnostics.

use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures_util::stream::Stream;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout};
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};

use crate::error::{CoreError, Result};
use crate::process::{ManagedChild, ResolvedCommand, engine_command, resolve};
use crate::util::tail;

/// One protocol line. Engines can emit whole file contents in a single frame.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 8 * 1024;
const ONE_SHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub(crate) struct EngineProcess {
    pub child: ManagedChild,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: StderrTail,
}

/// A grandchild can hold stderr open long after the engine exits, so a final read
/// waits only this long.
const STDERR_DRAIN: std::time::Duration = std::time::Duration::from_millis(500);

#[derive(Clone)]
pub(crate) struct StderrTail {
    buffer: Arc<Mutex<String>>,
    drained: tokio::sync::watch::Sender<bool>,
}

impl Default for StderrTail {
    fn default() -> Self {
        Self {
            buffer: Arc::default(),
            drained: tokio::sync::watch::channel(false).0,
        }
    }
}

impl StderrTail {
    fn start(self, mut stderr: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let tail_buffer = self.buffer.clone();
        let drained = self.drained.clone();
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
            drained.send_replace(true);
        });
        self
    }

    /// Waits for the reader to reach the end, because an exit can be observed
    /// before the reason for it has been read.
    pub async fn drained(&self) {
        let mut done = self.drained.subscribe();
        let _ = tokio::time::timeout(STDERR_DRAIN, done.wait_for(|finished| *finished)).await;
    }

    pub fn text(&self) -> String {
        let buffer = self
            .buffer
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
    spawn_engine_with(command, args, cwd, &[])
}

/// `spawn_engine` with environment variables set for this process alone.
pub(crate) fn spawn_engine_with(
    command: &ResolvedCommand,
    args: &[OsString],
    cwd: &Path,
    env: &[(&str, &str)],
) -> Result<EngineProcess> {
    let mut builder = engine_command(command, args, cwd);
    builder.envs(env.iter().copied());
    let mut child = ManagedChild::spawn(builder).map_err(|error| {
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

/// Runs a CLI once from a neutral folder with the prompt on stdin, so no
/// repository config or hooks load and the prompt stays out of argv.
pub(crate) async fn one_shot_cli(program: &str, args: &[&str], prompt: &str) -> Result<String> {
    let command = resolve_engine(program)?;
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let mut process = spawn_engine(&command, &args, &std::env::temp_dir())?;
    let mut stdout = process.stdout;
    let mut stdin = process.stdin;
    let child = &mut process.child;
    let work = async {
        stdin.write_all(prompt.as_bytes()).await?;
        drop(stdin);
        let mut output = String::new();
        stdout.read_to_string(&mut output).await?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, output))
    };
    let (status, output) = tokio::time::timeout(ONE_SHOT_TIMEOUT, work)
        .await
        .map_err(|_| CoreError::EngineUnavailable("The engine did not answer in time.".into()))??;
    if !status.success() {
        return Err(CoreError::EngineUnavailable(
            exit_message(Some(status), &process.stderr).await,
        ));
    }
    Ok(output)
}

pub(crate) fn lines(
    stdout: ChildStdout,
) -> impl Stream<Item = Result<String, LinesCodecError>> + Unpin {
    FramedRead::new(stdout, LinesCodec::new_with_max_length(MAX_LINE_BYTES))
}

/// Failure text for an engine that ended without finishing its protocol.
pub(crate) async fn exit_message(
    status: Option<std::process::ExitStatus>,
    stderr: &StderrTail,
) -> String {
    stderr.drained().await;
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
