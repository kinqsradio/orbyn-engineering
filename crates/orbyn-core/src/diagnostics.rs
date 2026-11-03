//! What the service can say about itself: the processes it started, how much memory
//! they hold over time, and the recent warnings. All of it stays in memory and goes
//! when the service stops.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use orbyn_contracts::{ResourceSample, ServiceEvent, ServiceProcess};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::error::{CoreError, Result};
use crate::util::now;

const HISTORY_SAMPLES: usize = 60;
const SAMPLE_EVERY: Duration = Duration::from_secs(60);
const EVENTS_KEPT: usize = 50;

static HISTORY: Mutex<VecDeque<ResourceSample>> = Mutex::new(VecDeque::new());
static EVENTS: Mutex<VecDeque<ServiceEvent>> = Mutex::new(VecDeque::new());

impl crate::app::Core {
    /// Local environment display name; no remote lookup or persistent identity.
    pub fn environment_label(&self) -> String {
        System::host_name()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Orbyn environment".to_owned())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `root` and every process below it, from `(pid, parent)` rows in any order.
fn descendants(rows: &[(u32, Option<u32>)], root: u32) -> HashSet<u32> {
    let mut found = HashSet::from([root]);
    loop {
        let before = found.len();
        for (pid, parent) in rows {
            if parent.is_some_and(|parent| found.contains(&parent)) {
                found.insert(*pid);
            }
        }
        if found.len() == before {
            return found;
        }
    }
}

fn snapshot() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cmd(UpdateKind::Never),
    );
    system
}

fn tree(system: &System) -> Vec<ServiceProcess> {
    let root = std::process::id();
    let rows: Vec<_> = system
        .processes()
        .iter()
        .map(|(pid, process)| (pid.as_u32(), process.parent().map(Pid::as_u32)))
        .collect();
    let family = descendants(&rows, root);
    let mut processes: Vec<_> = system
        .processes()
        .iter()
        .filter(|(pid, _)| family.contains(&pid.as_u32()))
        .map(|(pid, process)| ServiceProcess {
            pid: pid.as_u32(),
            parent: process.parent().map(Pid::as_u32),
            name: process.name().to_string_lossy().into_owned(),
            memory_bytes: process.memory(),
            running_seconds: process.run_time(),
        })
        .collect();
    processes.sort_by_key(|process| process.pid);
    processes
}

/// This service and everything it started.
pub fn service_processes() -> Vec<ServiceProcess> {
    tree(&snapshot())
}

/// Stops one process this service started. The service itself is not on offer.
pub fn stop_process(pid: u32) -> Result<()> {
    if pid == std::process::id() {
        return Err(CoreError::Invalid("The service can't stop itself.".into()));
    }
    let system = snapshot();
    if !tree(&system).iter().any(|process| process.pid == pid) {
        return Err(CoreError::NotFound("process".into()));
    }
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or_else(|| CoreError::NotFound("process".into()))?;
    if process.kill() {
        Ok(())
    } else {
        Err(CoreError::Internal("The process did not stop.".into()))
    }
}

fn keep<T>(ring: &mut VecDeque<T>, entry: T, limit: usize) {
    if ring.len() == limit {
        ring.pop_front();
    }
    ring.push_back(entry);
}

pub(crate) fn sample() {
    let processes = service_processes();
    let entry = ResourceSample {
        at: now(),
        memory_bytes: processes.iter().map(|process| process.memory_bytes).sum(),
        processes: processes.len(),
    };
    keep(&mut lock(&HISTORY), entry, HISTORY_SAMPLES);
}

/// Takes a sample now and one a minute after that, for the life of the runtime.
pub fn start_sampling() {
    tokio::spawn(async {
        let mut tick = tokio::time::interval(SAMPLE_EVERY);
        loop {
            tick.tick().await;
            sample();
        }
    });
}

pub fn resource_history() -> Vec<ResourceSample> {
    lock(&HISTORY).iter().cloned().collect()
}

/// Keeps a warning or error for the Maintenance page.
pub fn note_event(level: &str, target: &str, message: String) {
    let at = now();
    crate::telemetry_export::offer_log(&at, level, target, &message);
    let entry = ServiceEvent {
        at,
        level: level.to_owned(),
        target: target.to_owned(),
        message,
    };
    keep(&mut lock(&EVENTS), entry, EVENTS_KEPT);
}

pub fn recent_events() -> Vec<ServiceEvent> {
    lock(&EVENTS).iter().rev().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tree_is_found_in_any_order_and_strangers_stay_out() {
        let rows = [
            (30, Some(20)),
            (20, Some(10)),
            (10, Some(1)),
            (40, Some(1)),
            (50, None),
        ];
        assert_eq!(descendants(&rows, 10), HashSet::from([10, 20, 30]));
    }

    #[test]
    fn the_service_is_listed_and_cannot_stop_itself() {
        let own = std::process::id();
        assert!(service_processes().iter().any(|process| process.pid == own));
        assert!(matches!(stop_process(own), Err(CoreError::Invalid(_))));
    }

    #[test]
    fn a_stranger_cannot_be_stopped() {
        // The test runner's parent is not below this process.
        let parent = snapshot()
            .process(Pid::from_u32(std::process::id()))
            .and_then(|process| process.parent())
            .map(Pid::as_u32)
            .expect("a parent");
        assert!(matches!(stop_process(parent), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn a_ring_drops_its_oldest() {
        let mut ring = VecDeque::new();
        for entry in 0..4 {
            keep(&mut ring, entry, 3);
        }
        assert_eq!(ring, [1, 2, 3]);
    }
}
