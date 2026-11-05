//! Bounded JPEG recordings. Each recording owns its writer and cancellation fence.
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use image::{
    DynamicImage, ImageDecoder, Rgb, RgbImage,
    codecs::jpeg::{JpegDecoder, JpegEncoder},
};
use orbyn_contracts::{PreviewRecording, PreviewRecordingOptions};
use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, Result};

pub(super) const MAX_JPEG: usize = 16 * 1024 * 1024;
// Reserve space for the bounded final manifest within the 256 MiB artifact quota.
const MAX_BYTES: u64 = 256 * 1024 * 1024 - 64 * 1024;
const MAX_FRAMES: u64 = 3000;
const MAX_DURATION: Duration = Duration::from_secs(300);
// Across all tabs: decoded images and encoding work never run concurrently.
static COMPOSITOR: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));

#[derive(Clone, Default)]
struct Overlay {
    mouse: Option<(Instant, f64, f64)>,
    key: Option<(Instant, &'static str)>,
}

pub(super) struct CapturedFrame {
    jpeg: Vec<u8>,
    overlay: Overlay,
    at: Instant,
    #[cfg(test)]
    worker_started: Option<tokio::sync::oneshot::Sender<()>>,
}

struct Writer {
    frames: u64,
    bytes: u64,
    timestamps: Vec<u64>,
    last: Option<Instant>,
    error: Option<String>,
    finalized: bool,
}

pub(super) struct Recording {
    folder: PathBuf,
    options: PreviewRecordingOptions,
    started: Instant,
    stop: CancellationToken,
    overlay: Mutex<Overlay>,
    writer: Mutex<Writer>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Recording {
    pub fn start(folder: PathBuf, options: PreviewRecordingOptions) -> Result<Arc<Self>> {
        if ![1, 2, 5, 10].contains(&options.fps) {
            return Err(CoreError::Invalid(
                "Recording frame rate is 1, 2, 5 or 10 FPS.".into(),
            ));
        }
        let parent = folder
            .parent()
            .ok_or_else(|| CoreError::Invalid("A recording needs an artifact folder.".into()))?;
        std::fs::create_dir_all(parent)?;
        std::fs::create_dir(&folder)?;
        Ok(Arc::new(Self {
            folder,
            options,
            started: Instant::now(),
            stop: CancellationToken::new(),
            overlay: Mutex::new(Overlay::default()),
            writer: Mutex::new(Writer {
                frames: 0,
                bytes: 0,
                timestamps: Vec::new(),
                last: None,
                error: None,
                finalized: false,
            }),
        }))
    }

    pub fn cancel(&self) {
        self.stop.cancel();
    }

    pub fn active(&self) -> bool {
        !self.stop.is_cancelled()
    }

    pub fn published(&self) -> bool {
        self.writer.try_lock().is_ok_and(|writer| writer.finalized)
    }

    pub fn error(&self) -> Option<String> {
        match self.writer.try_lock() {
            Ok(writer) => writer.error.clone(),
            Err(std::sync::TryLockError::Poisoned(error)) => error
                .into_inner()
                .error
                .clone()
                .or_else(|| Some("Recording worker failed.".into())),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }

    pub fn keys_enabled(&self) -> bool {
        self.options.show_key_presses
    }

    pub async fn fail(self: &Arc<Self>, reason: &str) {
        if let Err(error) = self.finish(Some(reason)).await {
            tracing::warn!(%error, "could not finalize a failed recording");
        }
    }

    pub fn mouse(&self, x: f64, y: f64) {
        if self.options.show_mouse_presses
            && x.is_finite()
            && y.is_finite()
            && (0.0..=4096.0).contains(&x)
            && (0.0..=4096.0).contains(&y)
        {
            lock(&self.overlay).mouse = Some((Instant::now(), x, y));
        }
    }

    pub fn key(&self, key: &str, safe_focus: bool) {
        // No caller can submit an arbitrary label or printable text.
        let label = if safe_focus { key_label(key) } else { None };
        if self.options.show_key_presses {
            lock(&self.overlay).key = label.map(|label| (Instant::now(), label));
        }
    }

    pub fn clear_input(&self) {
        *lock(&self.overlay) = Overlay::default();
    }

    pub async fn due(self: &Arc<Self>) -> bool {
        if self.stop.is_cancelled() {
            return false;
        }
        if self.started.elapsed() >= MAX_DURATION {
            self.fail("Recording duration limit reached.").await;
            return false;
        }
        let Ok(writer) = self.writer.try_lock() else {
            return false;
        };
        writer.last.is_none_or(|last| {
            last.elapsed() >= Duration::from_secs_f64(1.0 / f64::from(self.options.fps))
        })
    }

    /// Snapshot input under the same page-session lock as the screenshot.
    pub fn capture(&self, jpeg: Vec<u8>) -> CapturedFrame {
        CapturedFrame {
            jpeg,
            overlay: lock(&self.overlay).clone(),
            at: Instant::now(),
            #[cfg(test)]
            worker_started: None,
        }
    }

    pub async fn frame(self: &Arc<Self>, captured: CapturedFrame) {
        if self.stop.is_cancelled() {
            return;
        }
        let Ok(permit) = COMPOSITOR.clone().acquire_owned().await else {
            return;
        };
        let recording = self.clone();
        // The blocking job owns the permit AND writer guard. Cancelling this
        // future cannot release either while JPEG work or a file write continues.
        let job = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            recording.write_frame(captured);
        })
        .await;
        if job.is_err() {
            self.fail("Recording worker failed.").await;
        }
    }

    fn write_frame(&self, captured: CapturedFrame) {
        #[cfg(test)]
        if let Some(started) = captured.worker_started {
            let _ = started.send(());
        }
        let CapturedFrame {
            jpeg: bytes,
            overlay,
            at,
            ..
        } = captured;
        let mut writer = lock(&self.writer);
        if self.stop.is_cancelled() {
            return;
        }
        let result = (|| -> std::result::Result<u64, String> {
            if self.started.elapsed() >= MAX_DURATION || writer.frames >= MAX_FRAMES {
                return Err("Recording duration or frame limit reached.".into());
            }
            if bytes.len() > MAX_JPEG {
                return Err("Recorded frame exceeds the JPEG size limit.".into());
            }
            let frame = if self.options.show_key_presses || self.options.show_mouse_presses {
                compose(&bytes, &overlay, at)?
            } else {
                jpeg_decoder(&bytes)?;
                bytes
            };
            let budget = MAX_BYTES.saturating_sub(writer.bytes);
            if frame.len() as u64 > budget {
                return Err("Recording byte limit reached.".into());
            }
            // Publish only complete JPEGs; a failed write can leave a bounded
            // .part file, never a numbered frame claimed as successful.
            let partial = self.folder.join(format!("{:06}.part", writer.frames));
            let path = self.folder.join(format!("{:06}.jpg", writer.frames));
            std::fs::write(&partial, &frame)
                .map_err(|_| "Could not write a recorded frame.".to_owned())?;
            std::fs::rename(partial, path)
                .map_err(|_| "Could not write a recorded frame.".to_owned())?;
            Ok(frame.len() as u64)
        })();
        match result {
            Ok(bytes) => {
                writer.frames += 1;
                writer.bytes += bytes;
                writer.last = Some(at);
                writer.timestamps.push(
                    u64::try_from(at.saturating_duration_since(self.started).as_millis())
                        .unwrap_or(u64::MAX),
                );
            }
            Err(error) => {
                writer.error = Some(error);
                self.stop.cancel();
                if let Err(error) = self.summary(&mut writer) {
                    tracing::warn!(%error, "could not finalize a failed recording");
                }
            }
        }
    }

    /// Cancel first, then wait on the actual writer, including a job whose
    /// original caller was cancelled. Each new recording has its own owner.
    pub async fn finish(self: &Arc<Self>, reason: Option<&str>) -> Result<PreviewRecording> {
        self.stop.cancel();
        let recording = self.clone();
        let reason = reason.map(str::to_owned);
        tokio::task::spawn_blocking(move || {
            let mut writer = lock(&recording.writer);
            if !writer.finalized && writer.error.is_none() {
                writer.error = reason;
            }
            recording.summary(&mut writer)
        })
        .await
        .map_err(|_| CoreError::Internal("Recording summary worker failed.".into()))?
    }

    fn summary(&self, writer: &mut Writer) -> Result<PreviewRecording> {
        if !writer.finalized {
            let summary = serde_json::json!({
                "fps": self.options.fps, "frames": writer.frames, "bytes": writer.bytes,
                "timestamps_ms": writer.timestamps, "error": writer.error,
                "show_key_presses": self.options.show_key_presses,
                "show_mouse_presses": self.options.show_mouse_presses,
            });
            let publication = (|| -> Result<()> {
                let data = serde_json::to_vec(&summary)?;
                let partial = self.folder.join("recording.json.part");
                std::fs::write(&partial, data)?;
                std::fs::rename(partial, self.folder.join("recording.json"))?;
                Ok(())
            })();
            if let Err(error) = publication {
                writer.error.get_or_insert_with(|| {
                    "Could not publish the recording summary. Try finishing again.".into()
                });
                return Err(error);
            }
            writer.finalized = true;
        }
        Ok(PreviewRecording {
            path: self.folder.to_string_lossy().into_owned(),
            frames: writer.frames,
            error: writer.error.clone(),
        })
    }
}

fn key_label(key: &str) -> Option<&'static str> {
    match key {
        "Enter" => Some("ENTER"),
        "Tab" => Some("TAB"),
        "Escape" => Some("ESC"),
        "ArrowUp" => Some("UP"),
        "ArrowDown" => Some("DOWN"),
        "ArrowLeft" => Some("LEFT"),
        "ArrowRight" => Some("RIGHT"),
        "Backspace" => Some("BACK"),
        "Delete" => Some("DEL"),
        _ => None,
    }
}

fn jpeg_decoder(bytes: &[u8]) -> std::result::Result<JpegDecoder<Cursor<&[u8]>>, String> {
    if bytes.len() > MAX_JPEG {
        return Err("Recorded JPEG is too large.".into());
    }
    let mut decoder = JpegDecoder::new(Cursor::new(bytes)).map_err(|_| "Invalid recorded JPEG.")?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err("Recorded dimensions exceed the limit.".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    decoder
        .set_limits(limits)
        .map_err(|_| "Recorded decoder limits are unsupported.")?;
    Ok(decoder)
}

fn compose(
    bytes: &[u8],
    overlay: &Overlay,
    captured_at: Instant,
) -> std::result::Result<Vec<u8>, String> {
    let decoder = jpeg_decoder(bytes)?;
    let (_, height) = decoder.dimensions();
    let mut pixels = DynamicImage::from_decoder(decoder)
        .map_err(|_| "Could not decode recorded JPEG.")?
        .into_rgb8();
    if let Some((_, x, y)) = overlay.mouse.filter(|(at, _, _)| {
        captured_at.saturating_duration_since(*at) < Duration::from_millis(700)
    }) {
        let (cx, cy) = (x.round() as i64, y.round() as i64);
        for dy in -12i64..=12 {
            for dx in -12i64..=12 {
                let radius = dx * dx + dy * dy;
                if (64..=144).contains(&radius) {
                    pixel(&mut pixels, cx + dx, cy + dy, [100, 100, 255]);
                }
            }
        }
    }
    if let Some((_, label)) = overlay
        .key
        .filter(|(at, _)| captured_at.saturating_duration_since(*at) < Duration::from_millis(700))
    {
        for y in (i64::from(height) - 40)..(i64::from(height) - 7) {
            for x in 6..(label.len() as i64 * 18 + 18) {
                pixel(&mut pixels, x, y, [24, 24, 30]);
            }
        }
        for (index, letter) in label.bytes().enumerate() {
            let glyph = glyph(letter);
            for (row, bits) in glyph.iter().enumerate() {
                for col in 0..5 {
                    if bits & (1 << (4 - col)) != 0 {
                        for dy in 0..3 {
                            for dx in 0..3 {
                                pixel(
                                    &mut pixels,
                                    12 + index as i64 * 18 + col * 3 + dx,
                                    i64::from(height) - 34 + row as i64 * 3 + dy,
                                    [240, 240, 255],
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 80)
        .encode_image(&DynamicImage::ImageRgb8(pixels))
        .map_err(|_| "Could not encode recorded JPEG.")?;
    Ok(out)
}

fn pixel(image: &mut RgbImage, x: i64, y: i64, color: [u8; 3]) {
    if x >= 0 && y >= 0 && x < i64::from(image.width()) && y < i64::from(image.height()) {
        image.put_pixel(x as u32, y as u32, Rgb(color));
    }
}

// Small original block lettering for the fixed, non-text key vocabulary only.
fn glyph(letter: u8) -> [u8; 7] {
    match letter {
        b'A' => [14, 17, 17, 31, 17, 17, 17],
        b'B' => [30, 17, 17, 30, 17, 17, 30],
        b'C' => [14, 17, 16, 16, 16, 17, 14],
        b'D' => [30, 17, 17, 17, 17, 17, 30],
        b'E' => [31, 16, 16, 30, 16, 16, 31],
        b'F' => [31, 16, 16, 30, 16, 16, 16],
        b'G' => [14, 17, 16, 23, 17, 17, 15],
        b'H' => [17, 17, 17, 31, 17, 17, 17],
        b'I' => [31, 4, 4, 4, 4, 4, 31],
        b'K' => [17, 18, 20, 24, 20, 18, 17],
        b'L' => [16, 16, 16, 16, 16, 16, 31],
        b'N' => [17, 25, 25, 21, 19, 19, 17],
        b'O' => [14, 17, 17, 17, 17, 17, 14],
        b'P' => [30, 17, 17, 30, 16, 16, 16],
        b'R' => [30, 17, 17, 30, 20, 18, 17],
        b'S' => [15, 16, 16, 14, 1, 1, 30],
        b'T' => [31, 4, 4, 4, 4, 4, 4],
        b'U' => [17, 17, 17, 17, 17, 17, 14],
        b'W' => [17, 17, 17, 21, 21, 21, 10],
        _ => [0; 7],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> PreviewRecordingOptions {
        PreviewRecordingOptions {
            fps: 5,
            show_key_presses: false,
            show_mouse_presses: false,
        }
    }

    fn folder() -> PathBuf {
        std::env::temp_dir().join(format!("recording-{}", crate::util::new_id()))
    }

    fn black() -> Vec<u8> {
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode_image(&DynamicImage::ImageRgb8(RgbImage::new(200, 100)))
            .unwrap();
        jpeg
    }

    #[test]
    fn saved_jpeg_contains_mouse_and_safe_key_pixels_without_page_injection() {
        let jpeg = compose(
            &black(),
            &Overlay {
                mouse: Some((Instant::now(), 50.0, 30.0)),
                key: Some((Instant::now(), "ENTER")),
            },
            Instant::now(),
        )
        .unwrap();
        let pixels = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8();
        assert!(
            pixels.get_pixel(60, 30)[2] > 100,
            "mouse ring must be in encoded JPEG"
        );
        assert!(
            pixels.get_pixel(12, 66)[0] > 150,
            "key glyph must be in encoded JPEG"
        );
        assert!(
            pixels.get_pixel(180, 20)[0] < 20,
            "unmarked page remains black"
        );
        assert!(compose(&vec![0; MAX_JPEG + 1], &Overlay::default(), Instant::now()).is_err());
    }

    #[test]
    fn printable_and_unknown_keys_cannot_become_labels() {
        for key in [
            "p",
            "123456",
            "synthetic-password",
            "Dead",
            "Process",
            "Unidentified",
            "",
        ] {
            assert_eq!(key_label(key), None);
        }
        assert_eq!(key_label("Enter"), Some("ENTER"));
    }

    #[test]
    fn dimension_headers_and_expired_input_are_rejected_before_rendering() {
        let mut wide = Vec::new();
        JpegEncoder::new_with_quality(&mut wide, 60)
            .encode_image(&DynamicImage::ImageRgb8(RgbImage::new(4097, 1)))
            .unwrap();
        assert!(jpeg_decoder(&wide).is_err());
        let now = Instant::now();
        let expired = Overlay {
            mouse: Some((now - Duration::from_secs(1), 50.0, 30.0)),
            key: Some((now - Duration::from_secs(1), "ENTER")),
        };
        assert_eq!(
            compose(&black(), &expired, now).unwrap(),
            compose(&black(), &Overlay::default(), now).unwrap()
        );
    }

    #[tokio::test]
    async fn captured_input_stays_with_its_frame_and_uncertain_focus_cannot_label_keys() {
        let recording = Recording::start(
            folder(),
            PreviewRecordingOptions {
                show_key_presses: true,
                show_mouse_presses: true,
                ..options()
            },
        )
        .unwrap();
        recording.key("Enter", false);
        assert!(lock(&recording.overlay).key.is_none());
        recording.key("synthetic-password", true);
        assert!(lock(&recording.overlay).key.is_none());
        recording.key("Enter", true);
        let frame = recording.capture(black());
        recording.clear_input();
        recording.frame(frame).await;
        let done = recording.finish(None).await.unwrap();
        let pixels = image::load_from_memory_with_format(
            &std::fs::read(PathBuf::from(done.path).join("000000.jpg")).unwrap(),
            image::ImageFormat::Jpeg,
        )
        .unwrap()
        .to_rgb8();
        assert!(
            pixels.get_pixel(12, 66)[0] > 150,
            "capture-time cue survives later input state changes"
        );
    }

    #[tokio::test]
    async fn manifest_write_failure_is_retryable_without_rewriting_frames() {
        let path = folder();
        let recording = Recording::start(path.clone(), options()).unwrap();
        recording.frame(recording.capture(black())).await;
        let first = std::fs::read(path.join("000000.jpg")).unwrap();
        std::fs::create_dir(path.join("recording.json.part")).unwrap();
        assert!(recording.finish(None).await.is_err());
        assert!(!recording.published());
        assert!(!recording.active());
        assert!(recording.error().unwrap().contains("publish"));
        std::fs::rename(
            path.join("recording.json.part"),
            path.join("write-obstacle"),
        )
        .unwrap();
        recording.frame(recording.capture(black())).await;
        let done = recording.finish(None).await.unwrap();
        assert_eq!(done.frames, 1);
        assert!(recording.published());
        assert_eq!(std::fs::read(path.join("000000.jpg")).unwrap(), first);
        assert!(!path.join("000001.jpg").exists());
        assert_eq!(recording.finish(None).await.unwrap().frames, 1);
    }

    #[tokio::test]
    async fn duration_and_byte_quotas_finish_with_an_error() {
        let mut recording = Recording::start(folder(), options()).unwrap();
        Arc::get_mut(&mut recording).unwrap().started = Instant::now() - MAX_DURATION;
        assert!(!recording.due().await);
        assert!(
            recording
                .finish(None)
                .await
                .unwrap()
                .error
                .unwrap()
                .contains("duration")
        );
        let recording = Recording::start(folder(), options()).unwrap();
        lock(&recording.writer).bytes = MAX_BYTES;
        recording.frame(recording.capture(black())).await;
        let done = recording.finish(None).await.unwrap();
        assert_eq!(done.frames, 0);
        assert!(done.error.unwrap().contains("byte"));
    }

    #[tokio::test]
    async fn stop_fences_a_frame_waiting_for_the_compositor() {
        let path = folder();
        let recording = Recording::start(path.clone(), options()).unwrap();
        let permit = COMPOSITOR.acquire().await.unwrap();
        let pending = recording.clone();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let write = tokio::spawn(async move {
            started.send(()).unwrap();
            pending.frame(pending.capture(black())).await
        });
        waiting.await.unwrap();
        let done = recording.finish(None).await.unwrap();
        assert_eq!(done.frames, 0);
        drop(permit);
        write.await.unwrap();
        assert!(!path.join("000000.jpg").exists());
        recording.frame(recording.capture(black())).await;
        assert!(
            !path.join("000000.jpg").exists(),
            "late captured frames must remain fenced"
        );
    }

    #[tokio::test]
    async fn cancelling_the_awaiting_caller_keeps_the_actual_writer_and_count_owned() {
        let path = folder();
        let recording = Recording::start(path.clone(), options()).unwrap();
        let held = recording.clone();
        let (locked, lock_seen) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = lock(&held.writer);
            locked.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        lock_seen.await.unwrap();
        let mut captured = recording.capture(black());
        let (started, started_seen) = tokio::sync::oneshot::channel();
        captured.worker_started = Some(started);
        let pending = recording.clone();
        let caller = tokio::spawn(async move { pending.frame(captured).await });
        let began = tokio::time::timeout(Duration::from_secs(2), started_seen).await;
        caller.abort();
        let _ = caller.await;
        let retained = COMPOSITOR.available_permits() == 0;
        // Always release the test's barrier before asserting, so failure reaps
        // the real blocking writer instead of stranding another test's permit.
        release.send(()).unwrap();
        holder.join().unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(2), COMPOSITOR.acquire())
            .await
            .unwrap()
            .unwrap();
        let done = recording.finish(None).await.unwrap();
        drop(permit);
        assert!(began.is_ok(), "actual blocking job must have started");
        assert!(
            retained,
            "caller cancellation must not release the running job's permit"
        );
        assert_eq!(
            done.frames, 1,
            "successful write survives cancellation of its caller"
        );
        assert!(path.join("000000.jpg").is_file());
        assert!(done.error.is_none());
    }

    #[tokio::test]
    async fn only_successful_writes_count_and_errors_survive_stop() {
        let path = folder();
        let recording = Recording::start(path.clone(), options()).unwrap();
        recording.frame(recording.capture(black())).await;
        assert!(path.join("000000.jpg").exists());
        // A directory at the next frame path deterministically refuses the file write.
        std::fs::create_dir(path.join("000001.jpg")).unwrap();
        recording.frame(recording.capture(black())).await;
        let done = recording.finish(None).await.unwrap();
        assert_eq!(done.frames, 1);
        assert_eq!(
            done.error.as_deref(),
            Some("Could not write a recorded frame.")
        );
        let summary: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join("recording.json")).unwrap()).unwrap();
        assert_eq!(summary["frames"], 1);
        assert_eq!(summary["timestamps_ms"].as_array().unwrap().len(), 1);
        assert!(summary["error"].is_string());
    }

    #[tokio::test]
    async fn quotas_and_off_default_labels_are_enforced_at_the_writer() {
        let recording = Recording::start(folder(), options()).unwrap();
        recording.mouse(20.0, 30.0);
        recording.key("Enter", true);
        assert!(lock(&recording.overlay).mouse.is_none());
        assert!(lock(&recording.overlay).key.is_none());
        lock(&recording.writer).frames = MAX_FRAMES;
        recording.frame(recording.capture(black())).await;
        assert!(
            recording
                .finish(None)
                .await
                .unwrap()
                .error
                .unwrap()
                .contains("limit")
        );
        assert!(
            Recording::start(
                folder(),
                PreviewRecordingOptions {
                    fps: 100,
                    ..options()
                }
            )
            .is_err()
        );
    }
}
