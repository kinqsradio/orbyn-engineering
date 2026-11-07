//! When a crashed service is started again by itself. It is once: a service that
//! stops again soon after its automatic restart is left stopped, for the person to
//! look at the log and try again by hand.

use std::time::{Duration, Instant};

/// A restarted service must run this long before a later crash earns another one.
pub const STABLE_AFTER: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Start the service again, now.
    RestartOnce,
    /// It was restarted once already and stopped again.
    Stop,
}

#[derive(Default)]
pub struct RestartPolicy {
    restarted_at: Option<Instant>,
}

impl RestartPolicy {
    /// Called when the service exits without being asked to.
    pub fn on_crash(&mut self, now: Instant) -> Decision {
        if self
            .restarted_at
            .is_some_and(|at| now.saturating_duration_since(at) < STABLE_AFTER)
        {
            return Decision::Stop;
        }
        self.restarted_at = Some(now);
        Decision::RestartOnce
    }

    /// A restart by hand clears the record, so the next crash gets its one restart.
    pub fn reset(&mut self) {
        self.restarted_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_crash_restarts_and_a_second_soon_after_stops() {
        let start = Instant::now();
        let mut policy = RestartPolicy::default();
        assert_eq!(policy.on_crash(start), Decision::RestartOnce);
        assert_eq!(
            policy.on_crash(start + Duration::from_secs(30)),
            Decision::Stop
        );
    }

    #[test]
    fn a_service_that_ran_long_enough_earns_another_restart() {
        let start = Instant::now();
        let mut policy = RestartPolicy::default();
        policy.on_crash(start);
        assert_eq!(policy.on_crash(start + STABLE_AFTER), Decision::RestartOnce);
    }

    #[test]
    fn a_restart_by_hand_clears_the_record() {
        let start = Instant::now();
        let mut policy = RestartPolicy::default();
        policy.on_crash(start);
        policy.reset();
        assert_eq!(
            policy.on_crash(start + Duration::from_secs(1)),
            Decision::RestartOnce
        );
    }
}
