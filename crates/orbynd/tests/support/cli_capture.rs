//! Test-only capture: bound both process exit and inherited pipe lifetime.
use std::{
    process::{Command, Output, Stdio},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

pub fn capture(command: Command, limit: Duration) -> Result<Output, String> {
    capture_inner(command, limit, None)
}

/// Only the pipe-lifetime fixture separates readiness from the measured deadline.
pub fn capture_ready(
    command: Command,
    limit: Duration,
    go: std::path::PathBuf,
    ready: std::path::PathBuf,
) -> Result<Output, String> {
    capture_inner(command, limit, Some((go, ready)))
}

fn capture_inner(
    command: Command,
    limit: Duration,
    readiness: Option<(std::path::PathBuf, std::path::PathBuf)>,
) -> Result<Output, String> {
    let label = format!(
        "{} {:?}",
        command.get_program().to_string_lossy(),
        command.get_args().collect::<Vec<_>>()
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(capture_async(command, limit, label, readiness))
}

async fn capture_async(
    command: Command,
    limit: Duration,
    label: String,
    readiness: Option<(std::path::PathBuf, std::path::PathBuf)>,
) -> Result<Output, String> {
    let mut command = tokio::process::Command::from(command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("{label}: spawn: {e}"))?;
    // Keep only the spawned child and capture pipes as live resource owners.
    drop(command);
    let pid = child.id().unwrap();
    #[cfg(unix)]
    let tree = orbyn_core::process::ProcessTree::from_group(pid as i32);
    #[cfg(windows)]
    let tree = match windows::Job::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let reaped = tokio::time::timeout(Duration::from_secs(3), child.kill()).await;
            return Err(format!(
                "{label}: process ownership: {error}; cleanup={reaped:?}"
            ));
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut status = None;
    let mut stage = "capture";
    let mut deadline = limit;
    let ready = if let Some((go, ready)) = readiness {
        // Ownership is established before the leader may create its descendant.
        std::fs::write(go, b"go").expect("write fixture barrier");
        tokio::time::timeout(Duration::from_secs(30), async {
            while !ready.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // The measured phase concerns inherited pipes alone. Establish the
            // leader's exit here, independently of its scheduling or final prints.
            status = Some(child.wait().await?);
            Ok::<_, std::io::Error>(())
        })
        .await
    } else {
        Ok(Ok(()))
    };
    let result = match ready {
        Err(error) => {
            stage = "fixture readiness";
            deadline = Duration::from_secs(30);
            Err(error)
        }
        Ok(Err(error)) => {
            stage = "fixture readiness";
            Ok(Err(error))
        }
        Ok(Ok(())) => {
            tokio::time::timeout(limit, async {
                tokio::try_join!(
                    async {
                        if status.is_none() {
                            status = Some(child.wait().await?);
                        }
                        Ok::<_, std::io::Error>(())
                    },
                    read(&mut stdout, &mut out),
                    read(&mut stderr, &mut err)
                )
            })
            .await
        }
    };
    if let Ok(Ok(_)) = result {
        // A successful CLI start deliberately leaves its service running.
        #[cfg(windows)]
        tree.release()
            .map_err(|e| format!("{label}: release job: {e}"))?;
        return Ok(Output {
            status: status.unwrap(),
            stdout: out,
            stderr: err,
        });
    }
    let leader_exited_before_deadline = status.is_some();
    tree.kill();
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    if let Ok(Ok(exit)) = reaped {
        status = Some(exit);
    }
    // Collect the last diagnostic bytes, but an escaped inherited pipe must
    // not keep either a reader thread or this runtime alive.
    let drained = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::try_join!(read(&mut stdout, &mut out), read(&mut stderr, &mut err))
    })
    .await;
    let reason = match result {
        Err(_) => "timed out".to_owned(),
        Ok(Err(error)) => format!("capture failed: {error}"),
        _ => unreachable!(),
    };
    Err(format!(
        "{label}: {reason} during {stage} after {deadline:?}; pid={pid}; status={status:?}; leader_exited_before_deadline={leader_exited_before_deadline}; reaped={}; drained={}\nstdout:\n{}\nstderr:\n{}",
        status.is_some(),
        matches!(drained, Ok(Ok(_))),
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    ))
}

async fn read(stream: &mut (impl AsyncRead + Unpin), bytes: &mut Vec<u8>) -> std::io::Result<()> {
    while stream.read_buf(bytes).await? != 0 {}
    Ok(())
}

#[cfg(windows)]
mod windows {
    use std::{
        io,
        mem::{size_of, zeroed},
        ptr::null,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
    };
    pub struct Job(HANDLE);
    impl Job {
        pub fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            // SAFETY: new handle has one owner; process handle is borrowed from
            // a live Child, and the information buffer has the declared size.
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Self(handle);
                job.flags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;
                let process = child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("child has no handle"))?;
                if AssignProcessToJobObject(handle, process) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }
        fn flags(&self, flags: u32) -> io::Result<()> {
            // SAFETY: initialized structure and matching size are valid for this call.
            unsafe {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = flags;
                if SetInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        }
        pub fn release(&self) -> io::Result<()> {
            self.flags(0)
        }
        pub fn kill(&self) {
            // SAFETY: this guard owns the live job handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: handle is uniquely owned and closed exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
