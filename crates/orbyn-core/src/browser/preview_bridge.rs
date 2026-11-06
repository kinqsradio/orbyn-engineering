//! What crosses between a preview's page and the person watching it: text they copy
//! out, files they choose for the page, and files the page downloads. The page is
//! untrusted, so each crossing waits for the person's own action and stays inside the
//! tab's folder under `<data>/preview-files/<tab>`, which ends with the tab. Pasting
//! is ordinary typed text and needs nothing here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use orbyn_contracts::PreviewDownload;
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::governance::computer::cdp::BrowserSession;
use crate::store::AuditRecord;
use crate::util::new_id;

/// One chosen file, the same bound as a message attachment.
pub const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
/// Everything chosen for one tab.
const MAX_TAB_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
/// A download past this is stopped, so a page cannot fill the disk.
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
/// Downloads kept per tab; the oldest finished one makes room.
const MAX_DOWNLOADS: usize = 20;
/// Copied text, in characters.
const MAX_COPY_CHARS: usize = 1_000_000;
const MAX_NAME_CHARS: usize = 120;

/// What the person has selected: the selection in a focused field, or else the
/// page's own. A password field gives nothing, as in any browser.
const COPY_SELECTION: &str = r"(() => {
  const el = document.activeElement;
  if (el && typeof el.value === 'string' && typeof el.selectionStart === 'number') {
    if (el.type === 'password') return '';
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return String(window.getSelection() || '');
})()";

/// The page's open file chooser: the input it belongs to, and whether it takes several.
struct Chooser {
    node: i64,
    many: bool,
}

/// A tab's crossings, apart from its page state.
#[derive(Default)]
pub struct Bridge {
    chooser: Option<Chooser>,
    downloads: Vec<PreviewDownload>,
    uploads: HashMap<String, PathBuf>,
    upload_bytes: u64,
}

impl Bridge {
    /// `one` or `many` while the page waits for files.
    pub fn chooser(&self) -> Option<String> {
        self.chooser
            .as_ref()
            .map(|chooser| if chooser.many { "many" } else { "one" }.to_owned())
    }

    pub fn downloads(&self) -> Vec<PreviewDownload> {
        self.downloads.clone()
    }
}

fn uploads(folder: &Path) -> PathBuf {
    folder.join("uploads")
}

fn downloads(folder: &Path) -> PathBuf {
    folder.join("downloads")
}

/// Asks the browser to hand file choosers to this side instead of failing them, and
/// to save downloads under the tab's folder by an id of its own, never the page's
/// name, so a page cannot pick where a file lands.
pub async fn enable(session: &mut BrowserSession, folder: &Path) -> Result<()> {
    let saved = downloads(folder);
    std::fs::create_dir_all(&saved)?;
    session
        .input(
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": true }),
        )
        .await?;
    session
        .browser_command(
            "Browser.setDownloadBehavior",
            json!({
                "behavior": "allowAndName",
                "downloadPath": saved.to_string_lossy(),
                "eventsEnabled": true,
            }),
        )
        .await?;
    Ok(())
}

/// A name that is safe to show and to save under on Windows and macOS: no folder,
/// no reserved character or device name, at most 120 characters.
pub fn safe_name(raw: &str, fallback: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    if trimmed.is_empty() {
        return fallback.to_owned();
    }
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_owned()
    }
}

/// A browser download id, which names its file, so nothing else may pass.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Reads what the browser reported since the last look. Returns the downloads to
/// stop: one past the size bound, or one with no room left in the list.
fn apply(bridge: &mut Bridge, events: Vec<Value>, folder: &Path) -> Vec<String> {
    let mut stop = Vec::new();
    for event in events {
        let params = event.get("params").cloned().unwrap_or(Value::Null);
        let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("");
        match event.get("method").and_then(Value::as_str) {
            Some("Page.fileChooserOpened") => {
                bridge.chooser = params
                    .get("backendNodeId")
                    .and_then(Value::as_i64)
                    .map(|node| Chooser {
                        node,
                        many: text("mode") == "selectMultiple",
                    });
            }
            Some("Browser.downloadWillBegin") => {
                let id = text("guid");
                if !valid_id(id) {
                    continue;
                }
                if bridge.downloads.len() >= MAX_DOWNLOADS {
                    let finished = bridge
                        .downloads
                        .iter()
                        .position(|kept| kept.state != "downloading");
                    let Some(index) = finished else {
                        stop.push(id.to_owned());
                        continue;
                    };
                    let old = bridge.downloads.remove(index);
                    let _ = std::fs::remove_file(downloads(folder).join(&old.id));
                }
                bridge.downloads.push(PreviewDownload {
                    id: id.to_owned(),
                    name: safe_name(text("suggestedFilename"), "download"),
                    bytes: 0,
                    state: "downloading".to_owned(),
                });
            }
            Some("Browser.downloadProgress") => {
                let id = text("guid");
                let Some(kept) = bridge.downloads.iter_mut().find(|kept| kept.id == id) else {
                    continue;
                };
                kept.bytes = params
                    .get("receivedBytes")
                    .and_then(Value::as_f64)
                    .map_or(kept.bytes, |bytes| bytes.max(0.0) as u64);
                kept.state = match text("state") {
                    "completed" => "done",
                    "canceled" => "stopped",
                    _ => "downloading",
                }
                .to_owned();
                if kept.state == "downloading" && kept.bytes > MAX_DOWNLOAD_BYTES {
                    kept.state = "stopped".to_owned();
                    stop.push(id.to_owned());
                }
            }
            _ => {}
        }
    }
    stop
}

/// Applies the browser's latest bridge events to a tab, stopping any download that
/// broke a bound. A browser that does not answer the stop is left; its tab folder
/// still goes when the tab ends.
pub async fn settle(
    bridge: &std::sync::Mutex<Bridge>,
    session: &mut BrowserSession,
    folder: &Path,
) {
    let events = session.take_events();
    if events.is_empty() {
        return;
    }
    let stop = apply(&mut lock(bridge), events, folder);
    for id in stop {
        let _ = session
            .browser_command("Browser.cancelDownload", json!({ "guid": id }))
            .await;
        let _ = std::fs::remove_file(downloads(folder).join(&id));
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn audit(
    core: &Core,
    actor: &str,
    thread_id: &str,
    action: &str,
    target: &str,
    detail: Value,
) -> Result<()> {
    core.store.append_audit(&AuditRecord {
        actor: actor.to_owned(),
        action: action.to_owned(),
        target: target.to_owned(),
        decision: None,
        source: "user".into(),
        thread_id: Some(thread_id.to_owned()),
        run_id: None,
        detail,
    })?;
    Ok(())
}

impl Core {
    /// The text a person selected in the page they hold, for their own clipboard.
    pub async fn copy_from_preview(&self, thread_id: &str, id: &str) -> Result<String> {
        let tab = self.previews.held_tab(thread_id, id)?;
        let value = tab.session.lock().await.read(COPY_SELECTION).await?;
        Ok(value
            .as_str()
            .unwrap_or("")
            .chars()
            .take(MAX_COPY_CHARS)
            .collect())
    }

    /// Keeps one file a person chose while the page waits for one. It lands in the
    /// tab's folder and reaches the page only when the chooser is answered.
    pub fn stage_preview_upload(
        &self,
        thread_id: &str,
        id: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<String> {
        let tab = self.previews.tab(thread_id, id)?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        {
            // The room is taken before writing, so two uploads at once cannot both fit.
            let mut bridge = lock(&tab.bridge);
            if bridge.chooser.is_none() {
                return Err(CoreError::Invalid(
                    "The page is not asking for a file.".into(),
                ));
            }
            if bytes.len() > MAX_UPLOAD_BYTES || bridge.upload_bytes + size > MAX_TAB_UPLOAD_BYTES {
                return Err(CoreError::Invalid(
                    "That file is too large for the preview.".into(),
                ));
            }
            bridge.upload_bytes += size;
        }
        let upload = new_id();
        let folder = uploads(&tab.files).join(&upload);
        let path = folder.join(safe_name(name, "file"));
        let written = std::fs::create_dir_all(&folder).and_then(|()| std::fs::write(&path, bytes));
        let mut bridge = lock(&tab.bridge);
        if let Err(error) = written {
            bridge.upload_bytes -= size;
            return Err(error.into());
        }
        bridge.uploads.insert(upload.clone(), path);
        Ok(upload)
    }

    /// Hands the chosen files to the input that asked, or none to cancel it. Only
    /// files staged for this tab can be named, so the page sees nothing else.
    pub async fn answer_preview_files(
        &self,
        thread_id: &str,
        id: &str,
        files: &[String],
        actor: &str,
    ) -> Result<()> {
        let tab = self.previews.tab(thread_id, id)?;
        let (node, paths) = {
            let mut bridge = lock(&tab.bridge);
            let Some(chooser) = bridge.chooser.take() else {
                return Err(CoreError::Invalid(
                    "The page is not asking for a file.".into(),
                ));
            };
            if files.len() > 1 && !chooser.many {
                bridge.chooser = Some(chooser);
                return Err(CoreError::Invalid("The page takes one file.".into()));
            }
            let mut paths = Vec::with_capacity(files.len());
            for file in files {
                let Some(path) = bridge.uploads.get(file) else {
                    bridge.chooser = Some(chooser);
                    return Err(CoreError::NotFound("file".into()));
                };
                paths.push(path.clone());
            }
            (chooser.node, paths)
        };
        if paths.is_empty() {
            return Ok(());
        }
        let names: Vec<String> = paths
            .iter()
            .filter_map(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .collect();
        let url = lock(&tab.info).url.clone();
        audit(
            self,
            actor,
            thread_id,
            "preview.files",
            &url,
            json!({ "files": names }),
        )?;
        let listed: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        tab.session
            .lock()
            .await
            .input(
                "DOM.setFileInputFiles",
                json!({ "files": listed, "backendNodeId": node }),
            )
            .await
    }

    /// A finished download's file and the name to save it under.
    pub fn preview_download(
        &self,
        thread_id: &str,
        id: &str,
        download: &str,
        actor: &str,
    ) -> Result<(PathBuf, String)> {
        let tab = self.previews.tab(thread_id, id)?;
        let name = lock(&tab.bridge)
            .downloads
            .iter()
            .find(|kept| kept.id == download && kept.state == "done")
            .map(|kept| kept.name.clone())
            .ok_or_else(|| CoreError::NotFound("download".into()))?;
        let path = downloads(&tab.files).join(download);
        if !path.is_file() {
            return Err(CoreError::NotFound("download".into()));
        }
        let url = lock(&tab.info).url.clone();
        audit(
            self,
            actor,
            thread_id,
            "preview.download",
            &url,
            json!({ "file": name }),
        )?;
        Ok((path, name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_one_safe_file() {
        assert_eq!(safe_name("../../etc/passwd", "f"), "passwd");
        assert_eq!(safe_name(r"C:\Users\a\report.pdf", "f"), "report.pdf");
        assert_eq!(safe_name("a<b>:c|d?.txt", "f"), "a_b__c_d_.txt");
        assert_eq!(safe_name("con.txt", "f"), "_con.txt");
        assert_eq!(safe_name("COM1", "f"), "_COM1");
        assert_eq!(safe_name("COMET.txt", "f"), "COMET.txt");
        assert_eq!(safe_name("..", "f"), "f");
        assert_eq!(safe_name(" name. ", "f"), "name");
        assert_eq!(safe_name("bell\u{7}.txt", "f"), "bell.txt");
        assert_eq!(
            safe_name(&"x".repeat(500), "f").chars().count(),
            MAX_NAME_CHARS
        );
    }

    fn event(method: &str, params: Value) -> Value {
        json!({ "method": method, "params": params })
    }

    #[test]
    fn a_chooser_and_downloads_are_read_from_events() {
        let folder = Path::new("unused");
        let mut bridge = Bridge::default();
        apply(
            &mut bridge,
            vec![event(
                "Page.fileChooserOpened",
                json!({ "backendNodeId": 7, "mode": "selectMultiple" }),
            )],
            folder,
        );
        assert_eq!(bridge.chooser().as_deref(), Some("many"));
        let stop = apply(
            &mut bridge,
            vec![
                event(
                    "Browser.downloadWillBegin",
                    json!({ "guid": "g-1", "suggestedFilename": "../x.csv" }),
                ),
                event(
                    "Browser.downloadWillBegin",
                    json!({ "guid": "../evil", "suggestedFilename": "y" }),
                ),
                event(
                    "Browser.downloadProgress",
                    json!({ "guid": "g-1", "receivedBytes": 12, "state": "completed" }),
                ),
            ],
            folder,
        );
        assert!(stop.is_empty());
        assert_eq!(
            bridge.downloads(),
            [PreviewDownload {
                id: "g-1".into(),
                name: "x.csv".into(),
                bytes: 12,
                state: "done".into(),
            }]
        );
    }

    #[test]
    fn downloads_are_bounded() {
        let folder = Path::new("unused");
        let mut bridge = Bridge::default();
        let begin = |id: String| event("Browser.downloadWillBegin", json!({ "guid": id }));
        let stop = apply(
            &mut bridge,
            vec![
                begin("big".into()),
                event(
                    "Browser.downloadProgress",
                    json!({ "guid": "big", "receivedBytes": 2_000_000_000_u64, "state": "inProgress" }),
                ),
            ],
            folder,
        );
        assert_eq!(stop, ["big"]);
        assert_eq!(bridge.downloads()[0].state, "stopped");
        let more: Vec<Value> = (0..MAX_DOWNLOADS).map(|n| begin(format!("d{n}"))).collect();
        let stop = apply(&mut bridge, more, folder);
        assert!(stop.is_empty(), "the stopped one made room");
        assert_eq!(bridge.downloads().len(), MAX_DOWNLOADS);
        let stop = apply(&mut bridge, vec![begin("over".into())], folder);
        assert_eq!(stop, ["over"], "every kept download is still running");
    }
}
