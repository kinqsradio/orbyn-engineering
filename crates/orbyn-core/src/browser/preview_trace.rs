//! Ephemeral, content-free input cues. Slow viewers never hold up page input.
use orbyn_contracts::PreviewPointer;
use tokio::sync::broadcast;

#[derive(Default)]
pub(super) struct Trace {
    sequence: u32,
}

impl Trace {
    pub fn emit(
        &mut self,
        events: &broadcast::Sender<PreviewPointer>,
        phase: &str,
        point: (f64, f64),
        size: (u32, u32),
    ) {
        let (x, y) = point;
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x > f64::from(size.0)
            || y > f64::from(size.1)
        {
            return;
        }
        // Exhaustion disables cues instead of wrapping to an older sequence.
        let Some(sequence) = self.sequence.checked_add(1) else {
            return;
        };
        self.sequence = sequence;
        let _ = events.send(PreviewPointer {
            sequence,
            phase: phase.to_owned(),
            x,
            y,
            width: size.0,
            height: size.1,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_points_and_keeps_sequence_without_viewers() {
        let (sender, _) = broadcast::channel(2);
        let mut trace = Trace::default();
        trace.emit(&sender, "click", (5.0, 6.0), (100, 100));
        let mut viewer = sender.subscribe();
        trace.emit(&sender, "click", (f64::NAN, 0.0), (100, 100));
        trace.emit(&sender, "click", (101.0, 0.0), (100, 100));
        trace.emit(&sender, "move", (50.0, 60.0), (100, 100));
        let event = viewer.try_recv().unwrap();
        assert_eq!(event.sequence, 2);
        assert_eq!((event.x, event.y), (50.0, 60.0));
        assert!(viewer.try_recv().is_err());
    }

    #[test]
    fn slow_viewer_drops_cues_and_sequence_never_wraps() {
        let (sender, mut viewer) = broadcast::channel(2);
        let mut trace = Trace::default();
        for _ in 0..4 {
            trace.emit(&sender, "click", (1.0, 1.0), (100, 100));
        }
        assert!(matches!(
            viewer.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        assert_eq!(viewer.try_recv().unwrap().sequence, 3);
        trace.sequence = u32::MAX;
        trace.emit(&sender, "click", (1.0, 1.0), (100, 100));
        assert_eq!(trace.sequence, u32::MAX);
    }
}
