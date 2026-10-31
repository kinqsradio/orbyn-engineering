//! Wakes followers after a commit. It carries only the newest `seq`; followers
//! always read events from the log, so a slow reader can neither miss nor
//! reorder anything, and there is no second copy of an event to keep in step.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::watch;

#[derive(Default)]
pub struct EventHub {
    threads: Mutex<HashMap<String, watch::Sender<i64>>>,
}

impl EventHub {
    pub fn subscribe(&self, thread_id: &str) -> watch::Receiver<i64> {
        self.lock()
            .entry(thread_id.to_owned())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    /// Called only after the event is durable.
    pub fn committed(&self, thread_id: &str, seq: i64) {
        let threads = self.lock();
        if let Some(sender) = threads.get(thread_id) {
            sender.send_if_modified(|current| {
                let advanced = seq > *current;
                if advanced {
                    *current = seq;
                }
                advanced
            });
        }
    }

    pub fn remove(&self, thread_id: &str) {
        self.lock().remove(thread_id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, watch::Sender<i64>>> {
        self.threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
