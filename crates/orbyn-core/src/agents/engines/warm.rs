//! Processes started ahead of a thread's next turn. Each holds an MCP token that is
//! revoked when the entry goes, unless a run adopted it.

use crate::agents::driver::WarmProcess;

/// A warm process for one thread, started after `after_run` completed.
pub struct WarmEntry {
    pub id: String,
    pub engine: String,
    /// The run whose end started this. Only the thread's next run may adopt it.
    pub after_run: String,
    pub token: String,
    pub url: String,
    process: Option<WarmProcess>,
    revoke: Option<Box<dyn FnOnce() + Send>>,
}

impl WarmEntry {
    pub fn new(
        engine: String,
        after_run: String,
        (token, url): (String, String),
        process: WarmProcess,
        revoke: Box<dyn FnOnce() + Send>,
    ) -> Self {
        Self {
            id: crate::util::new_id(),
            engine,
            after_run,
            token,
            url,
            process: Some(process),
            revoke: Some(revoke),
        }
    }

    /// Hands over the process; the token now belongs to the run that took it.
    pub fn adopt(mut self) -> WarmProcess {
        self.revoke = None;
        self.process.take().expect("a warm entry holds its process")
    }
}

impl Drop for WarmEntry {
    fn drop(&mut self) {
        // The process ends with its handle; the token must not outlive it.
        self.process = None;
        if let Some(revoke) = self.revoke.take() {
            revoke();
        }
    }
}
