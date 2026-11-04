//! The shell's bounded wait includes first-launch library provisioning.

use std::io::Write;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

// A cold install unpacks and indexes the bundled library before publishing ready.
// Leave room for that work while keeping startup failure bounded.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// Fixed milestones only; the smoke runner never needs addresses or launch tokens.
pub(crate) fn phase(value: &str) {
    if std::env::var_os("ORBYN_STARTUP_DIAGNOSTICS").as_deref() == Some(std::ffi::OsStr::new("1")) {
        write_phase(&mut std::io::stderr().lock(), value);
    }
}

fn write_phase(output: &mut impl Write, value: &str) {
    // Optional diagnostic I/O must never interrupt startup or child cleanup.
    let _ = writeln!(output, "[orbyn-startup] {value}");
}

pub(super) fn wait_for_ready(receiver: &Receiver<String>) -> Result<String, RecvTimeoutError> {
    wait_with_timeout(receiver, START_TIMEOUT)
}

fn wait_with_timeout(
    receiver: &Receiver<String>,
    limit: Duration,
) -> Result<String, RecvTimeoutError> {
    let result = receiver.recv_timeout(limit);
    match &result {
        Ok(_) => phase("readiness-received"),
        Err(RecvTimeoutError::Timeout) => phase("readiness-timeout"),
        Err(RecvTimeoutError::Disconnected) => phase("readiness-disconnected"),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_broken_diagnostic_pipe_does_not_interrupt_startup() {
        struct BrokenPipe;
        impl Write for BrokenPipe {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        write_phase(&mut BrokenPipe, "service-spawned");
    }

    #[test]
    fn cold_start_can_report_ready_after_the_old_twenty_second_deadline() {
        let (sender, receiver) = mpsc::channel();
        let child = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(21));
            let _ = sender.send("ready".to_owned());
        });
        let result = wait_for_ready(&receiver);
        child.join().unwrap();
        assert_eq!(result, Ok("ready".to_owned()));
    }

    #[test]
    fn a_silent_sender_still_has_a_finite_deadline() {
        let (_sender, receiver) = mpsc::channel();
        assert_eq!(
            wait_with_timeout(&receiver, Duration::from_millis(25)),
            Err(RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn a_closed_sender_is_not_mistaken_for_readiness() {
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        assert_eq!(
            wait_for_ready(&receiver),
            Err(RecvTimeoutError::Disconnected)
        );
    }
}
