//! The page a person watches beside a thread, and the servers a thread started. A
//! tab is a headless Chrome of its own, on a profile of its own, separate from the
//! governed browser agents use. Frames are polled and go out only while someone
//! watches or records. This is local: a client watches over the same access as the
//! rest of the API, and nothing here reaches another machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use orbyn_contracts::{
    BrowserProfile, LocalServer, PickedElement, PreviewInput, PreviewRecording, PreviewTab,
    PreviewView,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokio::process::Command;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::app::Core;
use crate::computer::cdp::{
    BrowserSession, HistoryState, LaunchOptions, find_browser, normalize_url,
};
use crate::error::{CoreError, Result};
use crate::store::AuditRecord;
use crate::util::new_id;

const MAX_TABS: usize = 4;
const FRAME_EVERY: Duration = Duration::from_millis(200);
const FRAME_QUALITY: u32 = 60;
const DEFAULT_SIZE: (u32, u32) = (1280, 800);
const CLI_TIMEOUT: Duration = Duration::from_secs(5);
const PROFILE_GRACE: Duration = Duration::from_millis(500);
/// Bounds a page's size, which sets how much memory each frame takes.
const SIZES: std::ops::RangeInclusive<u32> = 100..=4096;
/// How many frame ticks pass between looks at history, about one a second. A link
/// clicked in the page changes it with nobody telling this side.
const HISTORY_TICKS: u32 = 5;
const ZOOMS: std::ops::RangeInclusive<f64> = 0.25..=3.0;
const PROFILE_NAME_LIMIT: usize = 64;
/// How many crashes are put right, and over what time.
const CRASH_LIMIT: usize = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(30);
const CRASH_DELAY: Duration = Duration::from_secs(1);

/// A snapshot's bounds: how many elements an agent may read, and how long one
/// name, value, selector, address or text sample may be. They hold in the page and
/// again here, so a page that answers more than asked still stays small.
const MAX_SNAPSHOT_ELEMENTS: usize = 300;
const DEFAULT_SNAPSHOT_ELEMENTS: usize = 150;
const MAX_SNAPSHOT_TEXT: usize = 4_000;
const MAX_NAME_CHARS: usize = 120;
const MAX_VALUE_CHARS: usize = 120;
pub(crate) const MAX_SELECTOR_CHARS: usize = 300;
const MAX_ADDRESS_CHARS: usize = 2_000;
/// What an agent may ask a page to do at once: one typed string, one wheel of a
/// sane size, one expression, and one waited-for string.
pub(crate) const MAX_TYPE_CHARS: usize = 4_000;
pub(crate) const DEFAULT_SCROLL: f64 = 400.0;
/// Far more than a page can scroll, so a wheel event stays a wheel event.
pub(crate) const MAX_SCROLL: f64 = 100_000.0;
const MAX_EXPRESSION_CHARS: usize = 2_000;
const MAX_RESULT_BYTES: usize = 20_000;
/// A wait polls 150 ms apart and gives up inside the 45 seconds a tool has to
/// answer, with the round count holding even if the clock stalls.
const DEFAULT_WAIT_MS: u64 = 5_000;
const MAX_WAIT_MS: u64 = 20_000;
pub(crate) const MAX_WAIT_TEXT_CHARS: usize = 200;
const WAIT_POLL: Duration = Duration::from_millis(150);
const WAIT_ROUNDS: u32 = 140;

/// Reads the element under a point: its tag, a selector that finds it again, and a
/// bounded sample of what it holds.
const PICK_ELEMENT: &str = r"(() => {
  const el = document.elementFromPoint(__X__, __Y__);
  if (!el) return null;
  const path = [];
  for (let node = el; node && node.nodeType === 1 && path.length < 5; node = node.parentElement) {
    if (node.id) { path.unshift(`#${CSS.escape(node.id)}`); break; }
    const same = [...(node.parentElement?.children ?? [])].filter((other) => other.localName === node.localName);
    path.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
  }
  return {
    tag: el.localName,
    selector: path.join(' > '),
    text: (el.innerText ?? '').trim().slice(0, 500),
    html: el.outerHTML.slice(0, 1000),
  };
})()";

/// Walks the visible elements of a page into roles, names and selectors, with a
/// bounded sample of its text. Every field is cut here as well as in Rust, so one
/// snapshot of a huge page still costs about the same.
const SNAPSHOT_PAGE: &str = r"(() => {
  const LIMIT = __MAX_ELEMENTS__;
  const TEXT_LIMIT = __MAX_TEXT__;
  const NAME_LIMIT = 120;
  const VALUE_LIMIT = 120;
  const PATH_LIMIT = 5;
  const cut = (value, limit) => {
    const text = (value || '').trim().slice(0, limit);
    return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
  };
  const selectorOf = (el) => {
    const path = [];
    for (let node = el; node && node.nodeType === 1 && path.length < PATH_LIMIT; node = node.parentElement) {
      if (node.id) {
        path.unshift(`#${window.CSS && CSS.escape ? CSS.escape(node.id) : node.id}`);
        break;
      }
      const same = [...(node.parentElement ? node.parentElement.children : [])]
        .filter((other) => other.localName === node.localName);
      path.unshift(same.length > 1
        ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})`
        : node.localName);
    }
    return path.join(' > ');
  };
  const roleOf = (el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    switch (el.localName) {
      case 'button': return 'button';
      case 'a': return el.hasAttribute('href') ? 'link' : '';
      case 'textarea': return 'textbox';
      case 'select': return 'combobox';
      case 'img': return 'img';
      case 'input':
        if (type === 'hidden') return '';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        return 'textbox';
      default:
        if (el.isContentEditable) return 'textbox';
        return (el.getAttribute('role') || '').split(/\s+/)[0];
    }
  };
  const inner = (el) => (el.innerText != null ? el.innerText : el.textContent) || '';
  const nameOf = (el) => {
    const label = cut(el.getAttribute('aria-label'), NAME_LIMIT);
    if (label) return label;
    const shown = cut(inner(el).replace(/\s+/g, ' '), NAME_LIMIT);
    if (shown) return shown;
    return cut(
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'),
      NAME_LIMIT,
    );
  };
  const elements = [];
  let truncated = false;
  for (const el of document.querySelectorAll('body *')) {
    if (el.offsetParent === null) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const role = roleOf(el);
    const shown = cut(inner(el).replace(/\s+/g, ' '), NAME_LIMIT);
    if (!role && !shown) continue;
    if (elements.length >= LIMIT) { truncated = true; break; }
    const found = { role: role, name: nameOf(el), selector: selectorOf(el) };
    if (role === 'textbox' || role === 'combobox') {
      const value = typeof el.value === 'string' ? cut(el.value, VALUE_LIMIT) : '';
      if (value) found.value = value;
    }
    elements.push(found);
  }
  const body = document.body ? inner(document.body) : '';
  let text = body.slice(0, TEXT_LIMIT);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return {
    url: location.href,
    title: document.title,
    elements: elements,
    text: text,
    truncated: truncated || body.length > TEXT_LIMIT,
  };
})()";

/// Focuses one element and puts the caret at its end, so the text an agent types
/// appends to what the field already holds.
const FOCUS_ELEMENT: &str = r"(() => {
  const el = document.querySelector(__SELECTOR__);
  if (!el) return false;
  el.focus();
  if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (unusable) {}
  }
  return document.activeElement === el;
})()";

/// The point a wheel event goes to: an element's centre after it is brought into
/// view, or the middle of the viewport when the page is the target.
const SCROLL_POINT: &str = r"(() => {
  const selector = __SELECTOR__;
  let target = null;
  if (selector !== null) {
    target = document.querySelector(selector);
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
  }
  const box = target
    ? target.getBoundingClientRect()
    : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
})()";

/// A wait polls one boolean, so each look is a round trip of about a word.
const WAIT_SELECTOR: &str = "document.querySelector(__SELECTOR__) !== null";
const WAIT_TEXT: &str =
    "(() => (document.body ? document.body.innerText : '').includes(__TEXT__))()";
/// A selector the page cannot parse is refused once, before the wait starts.
const WAIT_SELECTOR_PARSES: &str = r"(() => {
  try { document.querySelector(__SELECTOR__); return true; } catch (unreadable) { return false; }
})()";

/// A snapshot's element limit: what was asked for, kept inside the cap.
fn snapshot_limit(asked: Option<u64>) -> usize {
    asked.map_or(DEFAULT_SNAPSHOT_ELEMENTS, |asked| {
        usize::try_from(asked)
            .unwrap_or(MAX_SNAPSHOT_ELEMENTS)
            .clamp(1, MAX_SNAPSHOT_ELEMENTS)
    })
}

/// A wait's length: five seconds unless asked for more, never past the cap.
fn wait_timeout(asked: Option<u64>) -> Duration {
    Duration::from_millis(asked.unwrap_or(DEFAULT_WAIT_MS).clamp(1, MAX_WAIT_MS))
}

/// At most `limit` characters, counted whole so no cut splits a character.
fn capped(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// One string field of a page's answer, or nothing.
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A page's snapshot with every field cut again here, in case the page answered
/// more than it was asked for.
fn capped_snapshot(page: &Value, limit: usize) -> Value {
    let mut elements: Vec<Value> = Vec::new();
    let mut truncated = page
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for entry in page
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if elements.len() >= limit {
            truncated = true;
            break;
        }
        let mut element = json!({
            "role": capped(field(entry, "role"), MAX_NAME_CHARS),
            "name": capped(field(entry, "name").trim(), MAX_NAME_CHARS),
            "selector": capped(field(entry, "selector").trim(), MAX_SELECTOR_CHARS),
        });
        let value = capped(field(entry, "value").trim(), MAX_VALUE_CHARS);
        if !value.is_empty() {
            element["value"] = json!(value);
        }
        elements.push(element);
    }
    let text = field(page, "text").trim();
    if text.chars().count() > MAX_SNAPSHOT_TEXT {
        truncated = true;
    }
    json!({
        "url": capped(field(page, "url"), MAX_ADDRESS_CHARS),
        "title": capped(field(page, "title").trim(), MAX_NAME_CHARS),
        "elements": elements,
        "text": capped(text, MAX_SNAPSHOT_TEXT),
        "truncated": truncated,
    })
}

/// What an agent gets from an expression: the whole value, or only its size,
/// never a value cut in half.
fn bounded_result(value: Value) -> Value {
    let bytes = serde_json::to_string(&value).map_or(usize::MAX, |text| text.len());
    if bytes > MAX_RESULT_BYTES {
        return json!({ "truncated": true, "bytes": bytes });
    }
    json!({ "value": value, "truncated": false })
}

/// An agent's expression, checked against the cap before the page runs it.
fn checked_expression(expression: &str) -> Result<&str> {
    if expression.chars().count() > MAX_EXPRESSION_CHARS {
        return Err(CoreError::Invalid(format!(
            "An expression is at most {MAX_EXPRESSION_CHARS} characters."
        )));
    }
    Ok(expression)
}

/// An expression that focuses one element, with the selector quoted as data.
fn focus_expression(selector: &str) -> String {
    FOCUS_ELEMENT.replace(
        "__SELECTOR__",
        &Value::String(selector.to_owned()).to_string(),
    )
}

/// An expression for the point a wheel event goes to, for one element or all.
fn scroll_expression(selector: Option<&str>) -> String {
    let target = selector.map_or_else(
        || "null".to_owned(),
        |sel| Value::String(sel.to_owned()).to_string(),
    );
    SCROLL_POINT.replace("__SELECTOR__", &target)
}

/// An expression that is true once a selector matches.
fn wait_selector_expression(selector: &str) -> String {
    WAIT_SELECTOR.replace(
        "__SELECTOR__",
        &Value::String(selector.to_owned()).to_string(),
    )
}

/// An expression that is true once the page's text holds a string.
fn wait_text_expression(text: &str) -> String {
    WAIT_TEXT.replace("__TEXT__", &Value::String(text.to_owned()).to_string())
}

/// An expression that is true when the page can parse a selector.
fn parses_expression(selector: &str) -> String {
    WAIT_SELECTOR_PARSES.replace(
        "__SELECTOR__",
        &Value::String(selector.to_owned()).to_string(),
    )
}

/// A snapshot expression, with the element limit kept inside the cap.
fn snapshot_expression(limit: usize) -> String {
    SNAPSHOT_PAGE
        .replace(
            "__MAX_ELEMENTS__",
            &limit.clamp(1, MAX_SNAPSHOT_ELEMENTS).to_string(),
        )
        .replace("__MAX_TEXT__", &MAX_SNAPSHOT_TEXT.to_string())
}

struct Recording {
    folder: PathBuf,
    frames: Arc<AtomicU64>,
}

struct Tab {
    info: Mutex<PreviewTab>,
    session: tokio::sync::Mutex<BrowserSession>,
    frames: broadcast::Sender<Arc<str>>,
    recording: Mutex<Option<Recording>>,
    stop: CancellationToken,
    profile: PathBuf,
    /// A named profile stays when the tab ends.
    keep_profile: bool,
    browser: PathBuf,
    options: LaunchOptions,
}

#[derive(Default)]
pub struct PreviewManager {
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Tab {
    fn view(&self) -> PreviewTab {
        let mut info = lock(&self.info).clone();
        info.viewers = self.frames.receiver_count();
        info.recording = lock(&self.recording).is_some();
        info
    }

    fn note_history(&self, history: &HistoryState) {
        let mut info = lock(&self.info);
        if !history.url.is_empty() {
            history.url.clone_into(&mut info.url);
        }
        info.can_go_back = history.can_go_back;
        info.can_go_forward = history.can_go_forward;
    }
}

fn check_size(width: u32, height: u32) -> Result<()> {
    if SIZES.contains(&width) && SIZES.contains(&height) {
        return Ok(());
    }
    Err(CoreError::Invalid(format!(
        "A preview is {} to {} pixels each way.",
        SIZES.start(),
        SIZES.end()
    )))
}

fn decode_base64(text: &str) -> Vec<u8> {
    let value = |byte: u8| match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u8);
    for six in text.bytes().filter_map(value) {
        bits = (bits << 6) | u32::from(six);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// How a tab starts, apart from where it goes.
#[derive(Clone, Debug, Default)]
pub struct OpenHow {
    pub private: bool,
    pub profile: Option<String>,
}

/// A page action an agent asked for, once its arguments are checked.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewAct {
    pub action: PreviewAction,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub dy: f64,
}

/// The three ways an agent may drive a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewAction {
    Click,
    Type,
    Scroll,
}

/// A `file:` address for an absolute path, with each part escaped.
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let escaped: String = text
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' | b':' => {
                char::from(byte).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect();
    if escaped.starts_with('/') {
        format!("file://{escaped}")
    } else {
        format!("file:///{escaped}")
    }
}

/// Crashes lately, which decide whether and when to try again.
#[derive(Default)]
struct Crashes(Vec<Instant>);

impl Crashes {
    /// How long to wait before starting again, growing each time, or `None` when
    /// this page keeps crashing and should be left.
    fn next_delay(&mut self, now: Instant) -> Option<Duration> {
        self.0.retain(|at| now.duration_since(*at) < CRASH_WINDOW);
        if self.0.len() >= CRASH_LIMIT {
            return None;
        }
        self.0.push(now);
        Some(CRASH_DELAY * 2u32.pow(u32::try_from(self.0.len() - 1).unwrap_or(0)))
    }
}

/// Starts the browser again on the same profile and page.
async fn bring_back(tab: &Tab, crashes: &mut Crashes) {
    let Some(delay) = crashes.next_delay(Instant::now()) else {
        lock(&tab.info).crashed = true;
        return;
    };
    tokio::time::sleep(delay).await;
    let view = lock(&tab.info).clone();
    let started = async {
        let mut session = BrowserSession::launch(&tab.browser, &tab.profile, tab.options).await?;
        session
            .set_view(view.width, view.height, view.zoom, view.mobile)
            .await?;
        session.set_appearance(&view.appearance).await?;
        session.navigate(&view.url).await?;
        Ok::<_, CoreError>(session)
    };
    match started.await {
        Ok(session) => *tab.session.lock().await = session,
        Err(error) => tracing::warn!(%error, "could not bring a preview back"),
    }
}

/// Polls frames while anyone wants them. A page that did not change sends nothing,
/// and a tab that stops answering just skips that frame.
async fn pump(tab: Arc<Tab>) {
    let mut last = Vec::new();
    let mut ticks = tokio::time::interval(FRAME_EVERY);
    let mut since_history = 0;
    let mut crashes = Crashes::default();
    let mut watching = 0;
    loop {
        tokio::select! {
            () = tab.stop.cancelled() => {
                // Dropping the last handle ends the browser; only then is its
                // profile finished with.
                let (profile, keep) = (tab.profile.clone(), tab.keep_profile);
                drop(tab);
                tokio::time::sleep(PROFILE_GRACE).await;
                if !keep {
                    let _ = std::fs::remove_dir_all(profile);
                }
                return;
            }
            _ = ticks.tick() => {}
        }
        let recording = lock(&tab.recording)
            .as_ref()
            .map(|rec| (rec.folder.clone(), rec.frames.clone()));
        let viewers = tab.frames.receiver_count();
        if viewers == 0 && recording.is_none() {
            watching = 0;
            continue;
        }
        // A viewer who just joined has no frame yet, even if the page hasn't changed.
        if viewers > watching {
            last.clear();
        }
        watching = viewers;
        since_history += 1;
        if since_history >= HISTORY_TICKS {
            since_history = 0;
            let mut session = tab.session.lock().await;
            let history = session.history().await;
            let title = session.title().await;
            drop(session);
            if let Ok(history) = history {
                tab.note_history(&history);
            }
            if let Ok(title) = title {
                lock(&tab.info).title = title;
            }
        }
        let Ok(frame) = tab.session.lock().await.frame(FRAME_QUALITY).await else {
            if !tab.session.lock().await.is_alive().await {
                bring_back(&tab, &mut crashes).await;
            }
            continue;
        };
        let digest = Sha256::digest(frame.as_bytes()).to_vec();
        if digest == last {
            continue;
        }
        last = digest;
        if let Some((folder, count)) = recording {
            let index = count.fetch_add(1, Ordering::Relaxed);
            let path = folder.join(format!("{index:06}.jpg"));
            if let Err(error) = std::fs::write(path, decode_base64(&frame)) {
                tracing::warn!(%error, "could not keep a recorded frame");
            }
        }
        let _ = tab.frames.send(Arc::from(frame));
    }
}

impl PreviewManager {
    fn tab(&self, thread_id: &str, id: &str) -> Result<Arc<Tab>> {
        lock(&self.tabs)
            .get(id)
            .filter(|tab| lock(&tab.info).thread_id == thread_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("preview".into()))
    }

    pub fn list(&self, thread_id: &str) -> Vec<PreviewTab> {
        lock(&self.tabs)
            .values()
            .map(|tab| tab.view())
            .filter(|tab| tab.thread_id == thread_id)
            .collect()
    }

    /// Everything a new viewer needs: the stream of frames.
    pub fn subscribe(&self, thread_id: &str, id: &str) -> Result<broadcast::Receiver<Arc<str>>> {
        Ok(self.tab(thread_id, id)?.frames.subscribe())
    }

    /// Takes the page or hands it back.
    pub fn set_control(&self, thread_id: &str, id: &str, human: bool) -> Result<PreviewTab> {
        let tab = self.tab(thread_id, id)?;
        let word = if human { "human" } else { "none" };
        word.clone_into(&mut lock(&tab.info).control);
        Ok(tab.view())
    }

    pub async fn navigate(&self, thread_id: &str, id: &str, url: &str) -> Result<PreviewTab> {
        let url = normalize_url(url)?;
        let tab = self.tab(thread_id, id)?;
        let mut session = tab.session.lock().await;
        session.navigate(&url).await?;
        let history = session.history().await?;
        drop(session);
        lock(&tab.info).url = url;
        tab.note_history(&history);
        Ok(tab.view())
    }

    /// One page back or forward. At either end this changes nothing.
    pub async fn step(&self, thread_id: &str, id: &str, back: bool) -> Result<PreviewTab> {
        let tab = self.tab(thread_id, id)?;
        let history = tab.session.lock().await.step_history(back).await?;
        tab.note_history(&history);
        Ok(tab.view())
    }

    pub async fn resize(
        &self,
        thread_id: &str,
        id: &str,
        width: u32,
        height: u32,
    ) -> Result<PreviewTab> {
        check_size(width, height)?;
        let tab = self.tab(thread_id, id)?;
        let (zoom, mobile) = {
            let info = lock(&tab.info);
            (info.zoom, info.mobile)
        };
        let mut session = tab.session.lock().await;
        session.set_view(width, height, zoom, mobile).await?;
        drop(session);
        {
            let mut info = lock(&tab.info);
            info.width = width;
            info.height = height;
        }
        Ok(tab.view())
    }

    /// Changes how a page is shown. A value the service won't take changes nothing.
    pub async fn set_view(
        &self,
        thread_id: &str,
        id: &str,
        view: &PreviewView,
    ) -> Result<PreviewTab> {
        if view.zoom.is_some_and(|zoom| !ZOOMS.contains(&zoom)) {
            return Err(CoreError::Invalid(format!(
                "Zoom is {} to {}.",
                ZOOMS.start(),
                ZOOMS.end()
            )));
        }
        if let Some(appearance) = &view.appearance
            && !["system", "light", "dark"].contains(&appearance.as_str())
        {
            return Err(CoreError::Invalid("Unknown appearance.".into()));
        }
        let tab = self.tab(thread_id, id)?;
        let current = lock(&tab.info).clone();
        let zoom = view.zoom.unwrap_or(current.zoom);
        let mobile = view.mobile.unwrap_or(current.mobile);
        let appearance = view.appearance.clone().unwrap_or(current.appearance);
        let mut session = tab.session.lock().await;
        session
            .set_view(current.width, current.height, zoom, mobile)
            .await?;
        session.set_appearance(&appearance).await?;
        drop(session);
        {
            let mut info = lock(&tab.info);
            info.zoom = zoom;
            info.mobile = mobile;
            info.appearance = appearance;
        }
        Ok(tab.view())
    }

    /// Answers a dialog the page opened. A page blocked on one does nothing else.
    pub async fn answer_dialog(
        &self,
        thread_id: &str,
        id: &str,
        accept: bool,
        text: Option<&str>,
    ) -> Result<bool> {
        let tab = self.tab(thread_id, id)?;
        let mut session = tab.session.lock().await;
        session.answer_dialog(accept, text).await
    }

    pub async fn reload(&self, thread_id: &str, id: &str, hard: bool) -> Result<PreviewTab> {
        let tab = self.tab(thread_id, id)?;
        tab.session.lock().await.reload(hard).await?;
        Ok(tab.view())
    }

    pub async fn clear(&self, thread_id: &str, id: &str, cookies: bool, cache: bool) -> Result<()> {
        let tab = self.tab(thread_id, id)?;
        let mut session = tab.session.lock().await;
        session.clear(cookies, cache).await
    }

    /// Reads the element at a point in the page, without touching the page.
    pub async fn pick(&self, thread_id: &str, id: &str, x: f64, y: f64) -> Result<PickedElement> {
        let tab = self.tab(thread_id, id)?;
        let zoom = lock(&tab.info).zoom;
        let expression = PICK_ELEMENT
            .replace("__X__", &(x / zoom).to_string())
            .replace("__Y__", &(y / zoom).to_string());
        let value = tab.session.lock().await.read(&expression).await?;
        serde_json::from_value(value).map_err(|_| CoreError::NotFound("element".into()))
    }

    /// A person's input, which needs them to hold the page, so a watcher cannot
    /// type into it by accident.
    pub async fn input(&self, thread_id: &str, id: &str, input: &PreviewInput) -> Result<()> {
        let tab = self.tab(thread_id, id)?;
        if lock(&tab.info).control != "human" {
            return Err(CoreError::Invalid(
                "Take control of this page first.".into(),
            ));
        }
        let mut session = tab.session.lock().await;
        let mouse = |kind: &str, buttons: u32, count: u32| {
            json!({
                "type": kind, "x": input.x, "y": input.y, "button": "left",
                "buttons": buttons, "clickCount": count,
            })
        };
        match input.kind.as_str() {
            "move" => {
                session
                    .input("Input.dispatchMouseEvent", mouse("mouseMoved", 0, 0))
                    .await
            }
            "click" => {
                session
                    .input("Input.dispatchMouseEvent", mouse("mousePressed", 1, 1))
                    .await?;
                session
                    .input("Input.dispatchMouseEvent", mouse("mouseReleased", 0, 1))
                    .await
            }
            "scroll" => {
                session
                    .input(
                        "Input.dispatchMouseEvent",
                        json!({
                            "type": "mouseWheel", "x": input.x, "y": input.y,
                            "deltaX": 0, "deltaY": input.delta_y,
                        }),
                    )
                    .await
            }
            "text" => {
                session
                    .input("Input.insertText", json!({ "text": input.text }))
                    .await
            }
            "key" => {
                for kind in ["keyDown", "keyUp"] {
                    session
                        .input(
                            "Input.dispatchKeyEvent",
                            json!({ "type": kind, "key": input.text, "code": input.text }),
                        )
                        .await?;
                }
                Ok(())
            }
            _ => Err(CoreError::Invalid("Unknown input.".into())),
        }
    }

    /// Reads the page's visible controls and a sample of its text. Both are capped
    /// in the page and here, so a snapshot of a busy page still fits in an answer.
    pub async fn snapshot(
        &self,
        thread_id: &str,
        id: &str,
        max_elements: Option<u64>,
    ) -> Result<Value> {
        let limit = snapshot_limit(max_elements);
        let tab = self.tab(thread_id, id)?;
        let page = tab
            .session
            .lock()
            .await
            .read(&snapshot_expression(limit))
            .await?;
        Ok(capped_snapshot(&page, limit))
    }

    /// Clicks one element, types into one field or turns the wheel once, so an
    /// agent drives the page no further than the one action it named.
    pub async fn act(&self, thread_id: &str, id: &str, step: &PreviewAct) -> Result<Value> {
        if step.action != PreviewAction::Scroll && step.selector.is_none() {
            return Err(CoreError::Invalid(
                "Name the selector of the element to act on.".into(),
            ));
        }
        let tab = self.tab(thread_id, id)?;
        let mut session = tab.session.lock().await;
        match step.action {
            PreviewAction::Click => {
                session
                    .click(step.selector.as_deref().unwrap_or_default())
                    .await
            }
            PreviewAction::Type => {
                let selector = step.selector.as_deref().unwrap_or_default();
                if session.read(&focus_expression(selector)).await? != json!(true) {
                    return Err(CoreError::Invalid(format!(
                        "Nothing to type into matches {selector}."
                    )));
                }
                let typed = step.text.as_deref().unwrap_or_default();
                session
                    .input("Input.insertText", json!({ "text": typed }))
                    .await?;
                Ok(json!({ "typed": typed }))
            }
            PreviewAction::Scroll => {
                let point = session
                    .read(&scroll_expression(step.selector.as_deref()))
                    .await?;
                let place = |key: &str| point.get(key).and_then(Value::as_f64);
                let (Some(x), Some(y)) = (place("x"), place("y")) else {
                    return Err(CoreError::Invalid(format!(
                        "Nothing to scroll matches {}.",
                        step.selector.as_deref().unwrap_or("this page")
                    )));
                };
                session
                    .input(
                        "Input.dispatchMouseEvent",
                        json!({
                            "type": "mouseWheel", "x": x, "y": y,
                            "deltaX": 0, "deltaY": step.dy,
                        }),
                    )
                    .await?;
                Ok(json!({ "scrolled": step.dy }))
            }
        }
    }

    /// Runs an agent's expression in the page and answers it whole, or only its
    /// size when the value is too big to pass on.
    pub async fn evaluate(&self, thread_id: &str, id: &str, expression: &str) -> Result<Value> {
        let expression = checked_expression(expression)?;
        let tab = self.tab(thread_id, id)?;
        let value = tab.session.lock().await.read(expression).await?;
        Ok(bounded_result(value))
    }

    /// Waits for a selector or a string to show up. Each poll takes the session for
    /// one boolean, so frames keep coming and other tools still run.
    pub async fn wait_for(
        &self,
        thread_id: &str,
        id: &str,
        selector: Option<&str>,
        wanted: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        let tab = self.tab(thread_id, id)?;
        let timeout = wait_timeout(timeout_ms);
        let expression = match (selector, wanted) {
            (Some(selector), None) => {
                if tab
                    .session
                    .lock()
                    .await
                    .read(&parses_expression(selector))
                    .await?
                    != json!(true)
                {
                    return Err(CoreError::Invalid(format!(
                        "{selector} is not a selector a page can read."
                    )));
                }
                wait_selector_expression(selector)
            }
            (None, Some(wanted)) => wait_text_expression(wanted),
            _ => {
                return Err(CoreError::Invalid(
                    "Name a selector or text to wait for, not both.".into(),
                ));
            }
        };
        let started = Instant::now();
        let waited = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        for _ in 0..WAIT_ROUNDS {
            let found = tab.session.lock().await.read(&expression).await;
            if found.as_ref().is_ok_and(|value| value == &json!(true)) {
                return Ok(json!({ "found": true, "waited_ms": waited() }));
            }
            // A page that navigated mid-poll answers an error, which is a miss and
            // not a reason to stop waiting.
            if started.elapsed() >= timeout {
                break;
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
        Ok(json!({ "found": false, "waited_ms": waited() }))
    }

    pub fn start_recording(&self, thread_id: &str, id: &str, folder: PathBuf) -> Result<()> {
        let tab = self.tab(thread_id, id)?;
        let mut recording = lock(&tab.recording);
        if recording.is_some() {
            return Err(CoreError::Invalid("This page is already recording.".into()));
        }
        std::fs::create_dir_all(&folder)?;
        *recording = Some(Recording {
            folder,
            frames: Arc::default(),
        });
        Ok(())
    }

    pub fn stop_recording(&self, thread_id: &str, id: &str) -> Result<PreviewRecording> {
        let tab = self.tab(thread_id, id)?;
        let finished = lock(&tab.recording)
            .take()
            .ok_or_else(|| CoreError::Invalid("This page is not recording.".into()))?;
        Ok(PreviewRecording {
            path: finished.folder.to_string_lossy().into_owned(),
            frames: finished.frames.load(Ordering::Relaxed),
        })
    }

    /// Ends a tab, its browser and its profile.
    pub fn close(&self, thread_id: &str, id: &str) -> Result<()> {
        self.tab(thread_id, id)?;
        if let Some(tab) = lock(&self.tabs).remove(id) {
            forget(&tab);
        }
        Ok(())
    }

    /// Ends every tab of a thread.
    pub fn close_thread(&self, thread_id: &str) {
        lock(&self.tabs).retain(|_, tab| {
            let keep = lock(&tab.info).thread_id != thread_id;
            if !keep {
                forget(tab);
            }
            keep
        });
    }

    pub fn close_all(&self) {
        for (_, tab) in lock(&self.tabs).drain() {
            forget(&tab);
        }
    }
}

/// Stops the pump, which holds the last handle and clears up after the browser.
fn forget(tab: &Tab) {
    tab.stop.cancel();
}

impl Core {
    /// Opens a page. It needs a trusted folder because the usual target is a server
    /// that folder's code is running, and a browser that Orbyn can find.
    pub async fn open_preview(
        &self,
        thread_id: &str,
        url: &str,
        size: (Option<u32>, Option<u32>),
        actor: &str,
        how: OpenHow,
    ) -> Result<PreviewTab> {
        let url = normalize_url(url)?;
        self.open_page(thread_id, url, size, actor, how).await
    }

    /// Opens a file from the thread's checkout. Anywhere else reads as not found.
    pub async fn open_preview_file(
        &self,
        thread_id: &str,
        path: &str,
        actor: &str,
    ) -> Result<PreviewTab> {
        let thread = self.store.thread(thread_id)?;
        let checkout = crate::util::canonicalize(Path::new(&thread.cwd))?;
        let file = crate::util::canonicalize(&checkout.join(path))
            .map_err(|_| CoreError::NotFound("file".into()))?;
        if !file.starts_with(&checkout) || !file.is_file() {
            return Err(CoreError::NotFound("file".into()));
        }
        let url = file_url(&file);
        self.open_page(thread_id, url, (None, None), actor, OpenHow::default())
            .await
    }

    async fn open_page(
        &self,
        thread_id: &str,
        url: String,
        size: (Option<u32>, Option<u32>),
        actor: &str,
        how: OpenHow,
    ) -> Result<PreviewTab> {
        let thread = self.store.thread(thread_id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let (width, height) = (
            size.0.unwrap_or(DEFAULT_SIZE.0),
            size.1.unwrap_or(DEFAULT_SIZE.1),
        );
        check_size(width, height)?;
        if lock(&self.previews.tabs).len() >= MAX_TABS {
            return Err(CoreError::Invalid(format!(
                "Close a preview first: {MAX_TABS} can be open at once."
            )));
        }
        let browser = self
            .config
            .browser_path
            .clone()
            .or_else(find_browser)
            .ok_or_else(|| CoreError::Unsupported("Install Chrome to use the preview.".into()))?;
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "preview.open".into(),
            target: url.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail: Value::Null,
        })?;
        let id = new_id();
        let profile = match &how.profile {
            Some(name) => self.claim_profile(name)?,
            None => self.config.data_dir.join("preview-profiles").join(&id),
        };
        let zoom = self
            .preference("preview_zoom", None)?
            .as_f64()
            .filter(|zoom| ZOOMS.contains(zoom))
            .unwrap_or(1.0);
        let appearance = self
            .preference("preview_appearance", None)?
            .as_str()
            .unwrap_or("system")
            .to_owned();
        let options = LaunchOptions {
            headless: true,
            in_process_gpu: self.config.browser_in_process_gpu,
        };
        let mut session = BrowserSession::launch(&browser, &profile, options).await?;
        session.set_view(width, height, zoom, false).await?;
        session.set_appearance(&appearance).await?;
        session.navigate(&url).await?;
        let title = session.title().await.unwrap_or_default();
        let (frames, _) = broadcast::channel(8);
        let tab = Arc::new(Tab {
            info: Mutex::new(PreviewTab {
                id: id.clone(),
                thread_id: thread_id.to_owned(),
                url,
                control: "none".to_owned(),
                recording: false,
                viewers: 0,
                width,
                height,
                can_go_back: false,
                can_go_forward: false,
                title,
                zoom,
                appearance,
                mobile: false,
                private: how.private,
                profile: how.profile.clone(),
                opened_by: if actor.starts_with("engine:") {
                    "agent".to_owned()
                } else {
                    "person".to_owned()
                },
                crashed: false,
            }),
            session: tokio::sync::Mutex::new(session),
            frames,
            recording: Mutex::new(None),
            stop: CancellationToken::new(),
            profile,
            keep_profile: how.profile.is_some(),
            browser,
            options,
        });
        lock(&self.previews.tabs).insert(id, tab.clone());
        let view = tab.view();
        tokio::spawn(pump(tab));
        Ok(view)
    }

    fn profile_folder(&self, id: &str) -> PathBuf {
        self.config.data_dir.join("browser-profiles").join(id)
    }

    fn stored_profiles(&self) -> Result<Vec<(String, String)>> {
        let list = self.preference("preview_profiles", None)?;
        Ok(list
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| {
                let text = |key: &str| entry.get(key)?.as_str().map(str::to_owned);
                Some((text("id")?, text("name")?))
            })
            .collect())
    }

    fn profile_open(&self, id: &str) -> bool {
        lock(&self.previews.tabs)
            .values()
            .any(|tab| lock(&tab.info).profile.as_deref() == Some(id))
    }

    /// A browser locks its profile, so a named one holds one tab at a time.
    fn claim_profile(&self, id: &str) -> Result<PathBuf> {
        if !self.stored_profiles()?.iter().any(|(known, _)| known == id) {
            return Err(CoreError::NotFound("browser profile".into()));
        }
        if self.profile_open(id) {
            return Err(CoreError::Invalid(
                "That profile is open in another tab.".into(),
            ));
        }
        Ok(self.profile_folder(id))
    }

    pub fn browser_profiles(&self) -> Result<Vec<BrowserProfile>> {
        Ok(self
            .stored_profiles()?
            .into_iter()
            .map(|(id, name)| BrowserProfile {
                in_use: self.profile_open(&id),
                id,
                name,
            })
            .collect())
    }

    fn save_profiles(&self, profiles: &[(String, String)]) -> Result<()> {
        let list: Vec<Value> = profiles
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect();
        let values =
            std::collections::BTreeMap::from([("preview_profiles".to_owned(), json!(list))]);
        self.set_preferences(None, &values)
    }

    pub fn create_browser_profile(&self, name: &str) -> Result<BrowserProfile> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > PROFILE_NAME_LIMIT {
            return Err(CoreError::Invalid(format!(
                "A profile name is 1 to {PROFILE_NAME_LIMIT} characters."
            )));
        }
        let mut profiles = self.stored_profiles()?;
        let id = new_id();
        profiles.push((id.clone(), name.to_owned()));
        self.save_profiles(&profiles)?;
        Ok(BrowserProfile {
            id,
            name: name.to_owned(),
            in_use: false,
        })
    }

    fn release_profile(&self, id: &str) -> Result<()> {
        if !self.stored_profiles()?.iter().any(|(known, _)| known == id) {
            return Err(CoreError::NotFound("browser profile".into()));
        }
        if self.profile_open(id) {
            return Err(CoreError::Invalid(
                "Close the tab using this profile first.".into(),
            ));
        }
        match std::fs::remove_dir_all(self.profile_folder(id)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// Empties a profile: cookies, storage and history go, and the name stays.
    pub fn clear_browser_profile(&self, id: &str) -> Result<()> {
        self.release_profile(id)
    }

    pub fn delete_browser_profile(&self, id: &str) -> Result<()> {
        self.release_profile(id)?;
        let mut profiles = self.stored_profiles()?;
        profiles.retain(|(known, _)| known != id);
        self.save_profiles(&profiles)
    }

    pub fn start_preview_recording(&self, thread_id: &str, id: &str) -> Result<()> {
        let folder = self
            .config
            .data_dir
            .join("browser-artifacts")
            .join(format!("{id}-{}", new_id()));
        self.previews.start_recording(thread_id, id, folder)
    }

    /// Servers listening from this thread's checkout. Where a process's folder
    /// cannot be read, every loopback listener is shown and marked as such.
    pub async fn local_servers(&self, thread_id: &str) -> Result<Vec<LocalServer>> {
        let thread = self.store.thread(thread_id)?;
        let checkout = crate::util::canonicalize(Path::new(&thread.cwd))?;
        Ok(listeners(&checkout).await)
    }

    /// Stops a server, only one this thread's checkout is running.
    pub async fn stop_server(&self, thread_id: &str, pid: u32, actor: &str) -> Result<()> {
        let servers = self.local_servers(thread_id).await?;
        if !servers
            .iter()
            .any(|server| server.pid == pid && server.in_checkout)
        {
            return Err(CoreError::NotFound("server".into()));
        }
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "server.stop".into(),
            target: pid.to_string(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail: Value::Null,
        })?;
        let pid = pid.to_string();
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            // A server has no window to ask politely, and its children hold the port.
            ("taskkill", vec!["/PID", &pid, "/T", "/F"])
        } else {
            ("kill", vec![&pid])
        };
        let status = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        if status.success() {
            Ok(())
        } else {
            Err(CoreError::Internal("The server did not stop.".into()))
        }
    }
}

async fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::child_env::for_tool(command.as_std_mut());
    let run = command.output();
    let done = tokio::time::timeout(CLI_TIMEOUT, run).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&done.stdout).into_owned())
}

/// `lsof -F` output: `p<pid>`, `c<command>`, `n<address>` lines.
fn parse_lsof(text: &str) -> Vec<(u32, String, u16)> {
    let mut found: Vec<(u32, String, u16)> = Vec::new();
    let (mut pid, mut name) = (0, String::new());
    for line in text.lines() {
        match line.split_at_checked(1) {
            Some(("p", rest)) => pid = rest.parse().unwrap_or(0),
            Some(("c", rest)) => rest.clone_into(&mut name),
            Some(("n", rest)) => {
                if let Some(port) = rest.rsplit(':').next().and_then(|port| port.parse().ok())
                    && !found.iter().any(|known| known.0 == pid && known.2 == port)
                {
                    found.push((pid, name.clone(), port));
                }
            }
            _ => {}
        }
    }
    found
}

/// Lists TCP listeners as JSON. Arguments, not a command line, and no profile runs.
const WINDOWS_LISTENERS: &[&str] = &[
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ \
     address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess; \
     process = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName \
     } } | ConvertTo-Json -Compress",
];

/// The output of `WINDOWS_LISTENERS`, which is an object for one row and a list for
/// more. Only loopback and wildcard addresses count, each port once.
fn parse_windows_listeners(text: &str) -> Vec<(u32, String, u16)> {
    let Ok(parsed) = serde_json::from_str::<Value>(text.trim()) else {
        return Vec::new();
    };
    let rows = match parsed {
        Value::Array(rows) => rows,
        row @ Value::Object(_) => vec![row],
        _ => Vec::new(),
    };
    let mut found: Vec<(u32, String, u16)> = Vec::new();
    for row in rows {
        let address = row.get("address").and_then(Value::as_str).unwrap_or("");
        if !["127.0.0.1", "::1", "0.0.0.0", "::"].contains(&address) {
            continue;
        }
        let number = |key: &str| row.get(key).and_then(Value::as_u64);
        let (Some(port), Some(pid)) = (number("port"), number("pid")) else {
            continue;
        };
        let (Ok(port), Ok(pid)) = (u16::try_from(port), u32::try_from(pid)) else {
            continue;
        };
        if !found.iter().any(|(_, _, seen)| *seen == port) {
            let process = row.get("process").and_then(Value::as_str).unwrap_or("");
            found.push((pid, process.to_owned(), port));
        }
    }
    found
}

/// `netstat -ano` lines for loopback or wildcard listeners.
fn parse_netstat(text: &str) -> Vec<(u32, String, u16)> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let [protocol, local, _, state, pid] = fields[..] else {
                return None;
            };
            if protocol != "TCP" || state != "LISTENING" {
                return None;
            }
            let port = local.rsplit(':').next()?.parse().ok()?;
            Some((pid.parse().ok()?, String::new(), port))
        })
        .collect()
}

/// The folder a process runs in, or `None` where the OS won't say, as for another
/// user's process.
fn process_folder(pid: u32) -> Option<PathBuf> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    system.process(pid)?.cwd().map(Path::to_path_buf)
}

/// Whether a process runs from the checkout, and `None` where that can't be known.
fn in_folder(pid: u32, checkout: &Path) -> Option<bool> {
    let folder = process_folder(pid)?;
    let folder = crate::util::canonicalize(&folder).ok()?;
    Some(folder.starts_with(checkout))
}

async fn listeners(checkout: &Path) -> Vec<LocalServer> {
    if cfg!(windows) {
        // PowerShell also names the process; `netstat` is here for when it cannot run.
        let found = match output("powershell.exe", WINDOWS_LISTENERS).await {
            Some(text) if !text.trim().is_empty() => parse_windows_listeners(&text),
            _ => Vec::new(),
        };
        let found = if found.is_empty() {
            let text = output("netstat", &["-ano", "-p", "TCP"])
                .await
                .unwrap_or_default();
            parse_netstat(&text)
        } else {
            found
        };
        // A service of the system won't name its folder, so it shows and can't be
        // stopped. One that does name a folder elsewhere is another project's.
        return found
            .into_iter()
            .filter_map(|(pid, process, port)| {
                let in_checkout = in_folder(pid, checkout);
                (in_checkout != Some(false)).then_some(LocalServer {
                    port,
                    pid,
                    process,
                    in_checkout: in_checkout == Some(true),
                })
            })
            .collect();
    }
    let text = output("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .await
        .unwrap_or_default();
    let mut servers = Vec::new();
    for (pid, process, port) in parse_lsof(&text) {
        if in_folder(pid, checkout) == Some(true) {
            servers.push(LocalServer {
                port,
                pid,
                process,
                in_checkout: true,
            });
        }
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_listeners_keep_local_ones_once_and_survive_bad_output() {
        let rows = r#"[
            {"address":"127.0.0.1","port":3000,"pid":10,"process":"node"},
            {"address":"::1","port":3000,"pid":10,"process":"node"},
            {"address":"192.168.1.4","port":22,"pid":11,"process":"ssh"},
            {"address":"0.0.0.0","port":99999,"pid":12,"process":"bad"},
            {"address":"::","port":5173,"pid":13,"process":null}
        ]"#;
        assert_eq!(
            parse_windows_listeners(rows),
            vec![(10, "node".to_owned(), 3000), (13, String::new(), 5173)]
        );
        let one = r#"{"address":"127.0.0.1","port":80,"pid":1,"process":"x"}"#;
        assert_eq!(parse_windows_listeners(one).len(), 1);
        assert!(parse_windows_listeners("Access denied").is_empty());
    }

    #[test]
    fn a_process_folder_is_read_on_this_platform() {
        let here = crate::util::canonicalize(&std::env::current_dir().unwrap()).unwrap();
        assert_eq!(in_folder(std::process::id(), &here), Some(true));
        let other = here.join("not-the-checkout");
        assert_eq!(in_folder(std::process::id(), &other), Some(false));
        assert_eq!(in_folder(u32::MAX - 1, &here), None);
    }

    #[test]
    fn a_crashing_page_gets_three_growing_tries_in_its_window() {
        let start = Instant::now();
        let mut crashes = Crashes::default();
        assert_eq!(crashes.next_delay(start), Some(Duration::from_secs(1)));
        assert_eq!(crashes.next_delay(start), Some(Duration::from_secs(2)));
        assert_eq!(crashes.next_delay(start), Some(Duration::from_secs(4)));
        assert_eq!(crashes.next_delay(start), None);
        let later = start + CRASH_WINDOW + Duration::from_secs(1);
        assert_eq!(crashes.next_delay(later), Some(Duration::from_secs(1)));
    }

    #[test]
    fn file_addresses_escape_what_a_path_can_hold() {
        assert_eq!(
            file_url(Path::new("/a b/c#d.html")),
            "file:///a%20b/c%23d.html"
        );
        assert_eq!(
            file_url(Path::new(r"C:\work\e.html")).replace("%5C", "/"),
            "file:///C:/work/e.html"
        );
    }

    #[test]
    fn base64_round_trips_jpeg_bytes() {
        assert_eq!(decode_base64("Zm9vYmFy"), b"foobar");
        assert_eq!(decode_base64("Zm8="), b"fo");
        assert_eq!(decode_base64("/9j/"), [0xff, 0xd8, 0xff]);
    }

    #[test]
    fn listeners_are_read_from_each_tool() {
        let lsof = "p12\ncnode\nf20\nn*:3000\nf21\nn[::1]:3000\np30\ncvite\nf1\nn127.0.0.1:5173\n";
        assert_eq!(
            parse_lsof(lsof),
            [(12, "node".to_owned(), 3000), (30, "vite".to_owned(), 5173)]
        );
        let netstat = "  TCP    127.0.0.1:8080   0.0.0.0:0   LISTENING   4242\n\
                       TCP    10.0.0.1:50000   1.2.3.4:443   ESTABLISHED   7\n";
        assert_eq!(parse_netstat(netstat), [(4242, String::new(), 8080)]);
    }

    #[test]
    fn a_snapshot_expression_carries_its_limit_inside_the_cap() {
        let expression = snapshot_expression(10_000);
        assert!(expression.contains("const LIMIT = 300;"), "{expression}");
        assert!(expression.contains("const TEXT_LIMIT = 4000;"));
        assert!(snapshot_expression(40).contains("const LIMIT = 40;"));
        assert!(snapshot_expression(0).contains("const LIMIT = 1;"));
    }

    #[test]
    fn a_snapshot_limit_is_what_was_asked_and_never_more() {
        assert_eq!(snapshot_limit(None), DEFAULT_SNAPSHOT_ELEMENTS);
        assert_eq!(snapshot_limit(Some(40)), 40);
        assert_eq!(snapshot_limit(Some(0)), 1);
        assert_eq!(snapshot_limit(Some(9_999)), MAX_SNAPSHOT_ELEMENTS);
        assert_eq!(snapshot_limit(Some(u64::MAX)), MAX_SNAPSHOT_ELEMENTS);
    }

    #[test]
    fn a_snapshot_is_cut_again_so_a_page_cannot_flood_an_agent() {
        let page = json!({
            "url": format!("http://a/{}", "u".repeat(MAX_ADDRESS_CHARS)),
            "title": "  t  ",
            "elements": [
                {
                    "role": "button",
                    "name": "n".repeat(MAX_NAME_CHARS + 80),
                    "selector": "s".repeat(MAX_SELECTOR_CHARS + 80),
                    "value": "v".repeat(MAX_VALUE_CHARS + 80),
                },
                { "role": "link", "name": "second", "selector": "#two" },
            ],
            "text": "t".repeat(MAX_SNAPSHOT_TEXT + 10),
            "truncated": false,
        });
        let snapshot = capped_snapshot(&page, 10);
        assert_eq!(snapshot["title"], "t");
        assert_eq!(
            snapshot["url"].as_str().unwrap().chars().count(),
            MAX_ADDRESS_CHARS
        );
        let first = &snapshot["elements"][0];
        assert_eq!(
            first["name"].as_str().unwrap().chars().count(),
            MAX_NAME_CHARS
        );
        assert_eq!(
            first["value"].as_str().unwrap().chars().count(),
            MAX_VALUE_CHARS
        );
        assert_eq!(
            first["selector"].as_str().unwrap().chars().count(),
            MAX_SELECTOR_CHARS
        );
        assert_eq!(
            snapshot["text"].as_str().unwrap().chars().count(),
            MAX_SNAPSHOT_TEXT
        );
        assert_eq!(snapshot["truncated"], true, "the text was cut here");
        assert_eq!(snapshot["elements"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["elements"][1]["selector"], "#two");
    }

    #[test]
    fn a_snapshot_stops_at_its_limit_and_says_so() {
        let elements: Vec<Value> = (0..5)
            .map(|index| json!({ "role": "button", "name": format!("b{index}"), "selector": format!("#b{index}") }))
            .collect();
        let page = json!({ "elements": elements, "text": "x" });
        let bounded = capped_snapshot(&page, 2);
        assert_eq!(bounded["elements"].as_array().unwrap().len(), 2);
        assert_eq!(bounded["truncated"], true);
        let whole = capped_snapshot(&page, 5);
        assert_eq!(whole["truncated"], false, "everything that came back fit");
        let empty = capped_snapshot(&json!({}), 10);
        assert_eq!(empty["elements"], json!([]));
        assert_eq!(empty["text"], "");
        assert_eq!(empty["truncated"], false);
    }

    #[test]
    fn an_expression_answers_whole_or_only_with_its_size() {
        let small = bounded_result(json!({ "a": 1 }));
        assert_eq!(small, json!({ "value": { "a": 1 }, "truncated": false }));
        let fits = "x".repeat(MAX_RESULT_BYTES - 2);
        assert_eq!(
            bounded_result(json!(fits))["truncated"],
            false,
            "a value of exactly the cap still fits"
        );
        let cut = bounded_result(json!("x".repeat(MAX_RESULT_BYTES)));
        assert_eq!(cut["truncated"], true);
        assert_eq!(
            cut["bytes"].as_u64().unwrap(),
            u64::try_from(MAX_RESULT_BYTES + 2).unwrap()
        );
        assert!(cut.get("value").is_none(), "a cut value is never sent");
    }

    #[test]
    fn an_expression_is_refused_past_its_cap() {
        assert_eq!(checked_expression("1 + 1").unwrap(), "1 + 1");
        let at_cap = "x".repeat(MAX_EXPRESSION_CHARS);
        assert!(checked_expression(&at_cap).is_ok());
        let long = "x".repeat(MAX_EXPRESSION_CHARS + 1);
        assert!(checked_expression(&long).is_err());
    }

    #[test]
    fn a_wait_is_bounded_in_time_and_in_rounds() {
        assert_eq!(
            wait_timeout(None),
            Duration::from_millis(DEFAULT_WAIT_MS),
            "five seconds unless asked"
        );
        assert_eq!(
            wait_timeout(Some(600_000)),
            Duration::from_millis(MAX_WAIT_MS)
        );
        assert_eq!(wait_timeout(Some(0)), Duration::from_millis(1));
        assert!(
            WAIT_POLL * WAIT_ROUNDS >= Duration::from_millis(MAX_WAIT_MS),
            "the rounds outlast the longest wait"
        );
    }

    #[test]
    fn the_page_expressions_quote_what_they_carry() {
        let awkward = r#"a"b'c\d`e"#;
        let quoted = Value::String(awkward.to_owned()).to_string();
        for expression in [
            focus_expression(awkward),
            scroll_expression(Some(awkward)),
            wait_selector_expression(awkward),
            wait_text_expression(awkward),
            parses_expression(awkward),
            scroll_expression(None),
            snapshot_expression(5),
        ] {
            assert!(!expression.contains("__"), "{expression}");
        }
        assert!(focus_expression(awkward).contains(&quoted));
        assert!(wait_selector_expression(awkward).contains(&quoted));
        assert!(wait_text_expression(awkward).contains(&quoted));
        assert!(parses_expression(awkward).contains(&quoted));
        assert!(scroll_expression(Some(awkward)).contains(&quoted));
        assert!(
            scroll_expression(None).contains("const selector = null;"),
            "the page is the target when no selector is named"
        );
    }
}
