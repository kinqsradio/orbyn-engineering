//! The terminal tier: an engine run in a PTY with no protocol. Orbyn cannot see
//! or gate what it does, so it is always labelled unmanaged.

use std::ffi::OsString;
use std::sync::Arc;

use async_trait::async_trait;
use orbyn_contracts::{AgUiEvent, AuthState, CustomEngine, EngineCapabilities, EngineTier};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::pipes::resolve_engine;
use super::{
    EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe, RunHandle, RunSpec,
};
use crate::error::Result;
use crate::terminal::{PtySpec, TerminalManager};

pub struct TerminalDriver {
    engine: CustomEngine,
    terminals: Arc<TerminalManager>,
}

impl TerminalDriver {
    pub fn new(engine: CustomEngine, terminals: Arc<TerminalManager>) -> Self {
        Self { engine, terminals }
    }
}

#[async_trait]
impl EngineDriver for TerminalDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: self.engine.id.clone(),
            name: self.engine.name.clone(),
            tier: EngineTier::Terminal,
            capabilities: EngineCapabilities {
                streaming: false,
                approvals: false,
                resume: false,
                mcp: false,
                sandbox: false,
                managed: false,
                skill_delivery: Vec::new(),
            },
        }
    }

    async fn probe(&self) -> EngineProbe {
        EngineProbe {
            path: crate::process::resolve(&self.engine.target).map(|command| command.path),
            auth: Some(AuthState::NotApplicable),
            ..EngineProbe::default()
        }
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let command = resolve_engine(&self.engine.target)?;
        let mut args = command.prefix.clone();
        args.extend(self.engine.args.iter().map(OsString::from));
        let session = self.terminals.open(
            &spec.thread_id,
            PtySpec {
                program: command.program,
                args,
                cwd: spec.cwd.clone(),
                cols: 120,
                rows: 32,
            },
        )?;
        session.write(spec.user_prompt.as_bytes())?;
        session.write(b"\r")?;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let terminals = self.terminals.clone();
        let thread_id = spec.thread_id;
        let mut exited = session.exited();
        let task = tokio::spawn(async move {
            let _ = events
                .send(
                    AgUiEvent::ActivitySnapshot {
                        message_id: "unmanaged".into(),
                        activity_type: "unmanaged".into(),
                        content: json!({
                            "message": "This engine runs in a terminal. Orbyn cannot review its actions."
                        }),
                        replace: Some(true),
                    }
                    .into(),
                )
                .await;
            let outcome = tokio::select! {
                () = stop.cancelled() => {
                    terminals.close(&thread_id);
                    EngineOutcome::Cancelled
                }
                code = wait_for_exit(&mut exited) => match code {
                    0 => EngineOutcome::Completed,
                    code => EngineOutcome::Failed(format!("The terminal exited with code {code}.")),
                },
            };
            let _ = events.send(EngineEvent::Finished(outcome)).await;
        });
        Ok(RunHandle {
            cancel,
            task,
            input: None,
        })
    }
}

async fn wait_for_exit(exited: &mut tokio::sync::watch::Receiver<Option<i32>>) -> i32 {
    loop {
        if let Some(code) = *exited.borrow_and_update() {
            return code;
        }
        if exited.changed().await.is_err() {
            return -1;
        }
    }
}
