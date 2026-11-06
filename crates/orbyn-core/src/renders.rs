//! Published pages. An agent writes HTML for a thread, Orbyn stores the page under
//! that thread's own app-data folder and copies the checkout pictures it names, so a
//! page that runs with no origin of its own can still show them. The page is never
//! read from the checkout at serve time, and one folder per render is the whole
//! record: there is no database row, so the folder is removed with its thread (see
//! `remove_renders`) and nothing accumulates across restarts by itself.
//!
//! Each publish also mints a frame token: the page runs in a frame, which cannot set
//! a header and whose URL is readable by the page's own scripts, so the service token
//! must never appear there. Only the token's digest is stored, in `frame.sha256`
//! beside the page, and core is the only place that can answer whether a presented
//! token belongs to one render (`render_frame_token_matches`). The access middleware
//! asks that question and nothing else.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::util::{new_id, random_token, secrets_match, sha256_hex};

/// A page may be this large; past it the publish is refused instead of stored.
pub const MAX_RENDER_HTML_BYTES: u64 = 512 * 1024;
/// One copied checkout image may be this large; a bigger one is left as written.
pub const MAX_RENDER_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// At most this many `<img>` srcs are copied; the rest are left as written.
pub const MAX_RENDER_IMAGES: usize = 32;
/// Renders kept per thread. The oldest folder goes when a newer one is published.
pub const MAX_RENDERS_PER_THREAD: usize = 20;

const RENDERS_FOLDER: &str = "renders";
const PAGE_FILE: &str = "index.html";
/// The digest of this render's frame token. Written before the page, so a served
/// page always has a hash to check against.
const FRAME_FILE: &str = "frame.sha256";
const PAGE_TYPE: &str = "text/html; charset=utf-8";

/// True when a document of this size is over the publish limit.
pub fn html_too_large(bytes: usize) -> bool {
    bytes as u64 > MAX_RENDER_HTML_BYTES
}

/// True when one checkout image is over the copy limit.
pub fn image_too_large(bytes: u64) -> bool {
    bytes > MAX_RENDER_IMAGE_BYTES
}

/// A render id is what this service writes and nothing else, so a caller cannot
/// name a folder of its own choosing.
pub fn is_render_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// The content type for an image extension, from the same list the raw-file route
/// uses, narrowed to images. Anything else is not embeddable.
fn image_type(extension: &str) -> Option<&'static str> {
    crate::file_bytes::inline_type(extension).filter(|kind| kind.starts_with("image/"))
}

/// Exactly `image-<n>.<ext>` with a known image extension: no separator, no `..`,
/// no second dot. Only these names are served back, so only these are written.
pub fn is_image_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("image-") else {
        return false;
    };
    let Some((count, extension)) = rest.split_once('.') else {
        return false;
    };
    !count.is_empty()
        && count.bytes().all(|byte| byte.is_ascii_digit())
        && image_type(extension).is_some()
}

/// One `<img>` `src` and where its value sits in the document.
#[derive(Debug, PartialEq, Eq)]
pub struct ImageSrc {
    /// The value exactly as written. Character references are not decoded.
    pub src: String,
    /// Byte span of the value in the document, quotes excluded.
    pub start: usize,
    pub end: usize,
}

/// Finds the `<img src=...>` values of a document, in the order they appear.
///
/// This is a scan, not an HTML parser. It does track `<script>`, `<style>` and
/// `<!-- -->` so a src written inside one is ignored, matches the tag name and the
/// attribute name case-insensitively, and accepts double-quoted, single-quoted and
/// unquoted values in any attribute order. It does not decode character references
/// (`&#x2f;`), does not follow `<base>`, and cannot see markup built by script or
/// written some other way, such as SVG's `<image href>`. Anything it misses is
/// simply left as the author wrote it.
pub fn image_srcs(html: &str) -> Vec<ImageSrc> {
    let bytes = html.as_bytes();
    let mut found = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        let Some(open) = bytes[at..]
            .iter()
            .position(|byte| *byte == b'<')
            .map(|offset| offset + at)
        else {
            break;
        };
        if starts_ci(bytes, open, b"<!--") {
            at = find_ci(bytes, open + 4, b"-->").map_or(bytes.len(), |end| end + 3);
            continue;
        }
        if let Some((start, end)) = tag_name_at(bytes, open) {
            let name = &bytes[start..end];
            if name.eq_ignore_ascii_case(b"script") || name.eq_ignore_ascii_case(b"style") {
                let mut closing = Vec::with_capacity(name.len() + 2);
                closing.extend_from_slice(b"</");
                closing.extend_from_slice(name);
                at = find_ci(bytes, end, &closing).unwrap_or(bytes.len());
                continue;
            }
            if name.eq_ignore_ascii_case(b"img")
                && let Some(image) = img_src_at(html, bytes, open)
            {
                found.push(image);
            }
        }
        at = open + 1;
    }
    found
}

/// Rewrites every found src that `keep` accepts. `keep` is asked once per src in
/// document order and returns the relative name to write, or `None` to leave that
/// src exactly as the author wrote it; it is not asked again once `limit` srcs have
/// been rewritten. Returns the new document and how many srcs changed.
pub fn embed_images(
    html: &str,
    limit: usize,
    keep: &mut dyn FnMut(&str) -> Option<String>,
) -> (String, usize) {
    let mut changes = Vec::new();
    for image in image_srcs(html) {
        if changes.len() >= limit {
            break;
        }
        let Some(name) = keep(&image.src) else {
            continue;
        };
        // Never write a src the image route would refuse to serve back.
        if !is_image_name(&name) {
            continue;
        }
        changes.push((image.start, image.end, name));
    }
    let mut page = html.to_owned();
    for (start, end, name) in changes.iter().rev() {
        page.replace_range(*start..*end, name);
    }
    (page, changes.len())
}

/// The checkout-relative path a src names, or `None` when the src is not a checkout
/// path at all: an http(s) or other scheme-bearing URL, a protocol-relative URL, a
/// `#` fragment or an absolute path outside the checkout. A relative path is handed
/// on untouched and still has to pass the file rules, so `..`, a link out of the
/// checkout and `.git` are refused there.
pub fn checkout_relative(src: &str, checkout: &Path) -> Option<String> {
    if src.is_empty() || src.starts_with(['#', '?']) || src.starts_with("//") {
        return None;
    }
    let path = Path::new(src);
    if path.is_absolute() {
        return relative_text(path.strip_prefix(checkout).ok()?);
    }
    if scheme_of(src).is_some() {
        return None;
    }
    Some(src.to_owned())
}

/// A URL scheme, per `scheme ":"`. Checked after `is_absolute`, so a Windows drive
/// path that the platform itself reports as absolute is a path and not a scheme.
fn scheme_of(src: &str) -> Option<&str> {
    let (before, _) = src.split_once(':')?;
    let mut chars = before.chars();
    let first = chars.next()?;
    (before.len() > 1
        && first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
    .then_some(before)
}

/// A path's own components joined with `/`. `None` for anything that leaves the
/// path through `..`, which is only reached for an absolute src.
fn relative_text(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn starts_ci(bytes: &[u8], at: usize, needle: &[u8]) -> bool {
    bytes.len() >= at + needle.len() && bytes[at..at + needle.len()].eq_ignore_ascii_case(needle)
}

fn find_ci(bytes: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from >= bytes.len() || bytes.len() < needle.len() {
        return None;
    }
    (from..=bytes.len() - needle.len())
        .find(|at| bytes[*at..*at + needle.len()].eq_ignore_ascii_case(needle))
}

fn find_byte(bytes: &[u8], from: usize, byte: u8) -> Option<usize> {
    bytes
        .get(from..)?
        .iter()
        .position(|it| *it == byte)
        .map(|at| at + from)
}

fn skip_space(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    at
}

fn is_attr_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':')
}

/// The name of the tag starting at `at`, as a byte range, when `<` begins one there.
fn tag_name_at(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    if bytes.get(at) != Some(&b'<') {
        return None;
    }
    let start = at + 1;
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
        end += 1;
    }
    (end > start).then_some((start, end))
}

/// The first `src` of the `<img>` tag starting at `at`, if it has one.
fn img_src_at(html: &str, bytes: &[u8], at: usize) -> Option<ImageSrc> {
    let (_, name_end) = tag_name_at(bytes, at)?;
    if bytes
        .get(name_end)
        .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b'/' | b'>'))
    {
        // `<imgfoo` is another tag.
        return None;
    }
    let mut i = name_end;
    while i < bytes.len() && bytes[i] != b'>' {
        i = skip_space(bytes, i);
        if i >= bytes.len() || bytes[i] == b'>' {
            return None;
        }
        if bytes[i] == b'/' {
            i += 1;
            continue;
        }
        let name_start = i;
        while i < bytes.len() && is_attr_char(bytes[i]) {
            i += 1;
        }
        if i == name_start {
            // Never stand still, whatever byte this is.
            i += 1;
            continue;
        }
        let is_src = bytes[name_start..i].eq_ignore_ascii_case(b"src");
        i = skip_space(bytes, i);
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i = skip_space(bytes, i + 1);
        if i >= bytes.len() {
            return None;
        }
        let (value, start, end, next) = match bytes[i] {
            quote @ (b'"' | b'\'') => {
                let start = i + 1;
                let end = find_byte(bytes, start, quote)?;
                (html.get(start..end)?.to_owned(), start, end, end + 1)
            }
            _ => {
                let start = i;
                let mut end = i;
                while end < bytes.len() && !bytes[end].is_ascii_whitespace() && bytes[end] != b'>' {
                    end += 1;
                }
                (html.get(start..end)?.to_owned(), start, end, end)
            }
        };
        if is_src {
            return Some(ImageSrc {
                src: value,
                start,
                end,
            });
        }
        i = next;
    }
    None
}

/// Keeps at most `keep` render folders, removing the oldest first. Age is the
/// folder's own modification time, with the folder name (a ULID) breaking a tie.
fn evict_renders(folder: &Path, keep: usize) {
    let Ok(items) = std::fs::read_dir(folder) else {
        return;
    };
    let mut folders: Vec<(SystemTime, String)> = items
        .flatten()
        .filter(|item| item.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|item| {
            let name = item.file_name().to_str()?.to_owned();
            let at = item
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((at, name))
        })
        .collect();
    if folders.len() <= keep {
        return;
    }
    folders.sort();
    for (_, name) in &folders[..folders.len() - keep] {
        let _ = std::fs::remove_dir_all(folder.join(name));
    }
}

/// What a publish stored: the render, the path that serves it and what it copied.
pub struct PublishedRender {
    pub id: String,
    /// The page's own route, with no query. A client adds `?render=<frame_token>`,
    /// because a frame cannot set an `Authorization` header and must not carry the
    /// service token in a URL its own page can read.
    pub url: String,
    /// The capability that opens exactly this render in a frame. Only its digest is
    /// kept, so the publish response is the only time the token exists in the clear.
    pub frame_token: String,
    pub images: usize,
    pub bytes: usize,
}

/// Where every thread's renders are kept.
pub fn renders_root(data_dir: &Path) -> PathBuf {
    data_dir.join(RENDERS_FOLDER)
}

/// Stores an MCP App's page as one of the thread's renders, the same way an agent's
/// page is stored but with nothing embedded: its HTML comes from an outside MCP
/// server, so no checkout image is copied in and its `src` values stay as written.
/// Only a run calls this, and a run only starts in a trusted folder.
pub fn publish_app_page(root: &Path, thread_id: &str, html: &str) -> Result<PublishedRender> {
    if html_too_large(html.len()) {
        return Err(CoreError::Invalid(format!(
            "This page is {} bytes, over the {} byte (512 KiB) render limit.",
            html.len(),
            MAX_RENDER_HTML_BYTES
        )));
    }
    let folder = root.join(thread_id);
    std::fs::create_dir_all(&folder)?;
    evict_renders(&folder, MAX_RENDERS_PER_THREAD.saturating_sub(1));
    let id = new_id();
    let dir = folder.join(&id);
    std::fs::create_dir_all(&dir)?;
    let frame_token = random_token()?;
    std::fs::write(dir.join(FRAME_FILE), sha256_hex(frame_token.as_bytes()))?;
    std::fs::write(dir.join(PAGE_FILE), html.as_bytes())?;
    Ok(PublishedRender {
        url: format!("/api/threads/{thread_id}/renders/{id}"),
        id,
        frame_token,
        images: 0,
        bytes: html.len(),
    })
}

/// The bytes of one published file, ready to send as they are.
pub struct RenderFile {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

impl Core {
    fn renders_root(&self) -> PathBuf {
        renders_root(&self.config.data_dir)
    }

    /// Stores an agent's page under this thread's renders and copies the checkout
    /// images it names. A page over the limit is refused whole; anything wrong with
    /// one image is refused per image, leaving that src as written.
    pub fn publish_render(&self, thread_id: &str, html: &str) -> Result<PublishedRender> {
        let (_, scope) = self.file_scope(thread_id)?;
        if html_too_large(html.len()) {
            return Err(CoreError::Invalid(format!(
                "This page is {} bytes, over the {} byte (512 KiB) render limit.",
                html.len(),
                MAX_RENDER_HTML_BYTES
            )));
        }
        let folder = self.renders_root().join(thread_id);
        std::fs::create_dir_all(&folder)?;
        // Room is made before this render exists, so the folder just created can
        // never be the one evicted.
        evict_renders(&folder, MAX_RENDERS_PER_THREAD.saturating_sub(1));
        let id = new_id();
        let dir = folder.join(&id);
        std::fs::create_dir_all(&dir)?;
        // The frame capability comes first, so a folder the page route can open
        // always carries the hash its frame URL is checked against. The token itself
        // is never written, and it is gone from this process once the caller has it.
        let frame_token = random_token()?;
        std::fs::write(dir.join(FRAME_FILE), sha256_hex(frame_token.as_bytes()))?;
        let mut copied = 0usize;
        let (page, images) = embed_images(html, MAX_RENDER_IMAGES, &mut |src| {
            // `open_raw_file` is the same read every file route uses: it needs the
            // thread's trusted scope, resolves the path and refuses `..`, a link
            // out, `.git` and a non-file. A refusal here leaves the src alone.
            let path = checkout_relative(src, &scope.checkout)?;
            let raw = self.open_raw_file(thread_id, &path, false).ok()?;
            if !raw.inline || image_too_large(raw.size) {
                return None;
            }
            let extension = Path::new(&path)
                .extension()
                .map(|it| it.to_string_lossy().to_ascii_lowercase())
                .filter(|it| image_type(it).is_some())?;
            let mut bytes = Vec::with_capacity(usize::try_from(raw.size).unwrap_or(0));
            let mut file = raw.file;
            file.read_to_end(&mut bytes).ok()?;
            let name = format!("image-{}.{extension}", copied + 1);
            std::fs::write(dir.join(&name), &bytes).ok()?;
            copied += 1;
            Some(name)
        });
        // The page is written last, so a half-published render is never served.
        std::fs::write(dir.join(PAGE_FILE), page.as_bytes())?;
        Ok(PublishedRender {
            id: id.clone(),
            url: format!("/api/threads/{thread_id}/renders/{id}"),
            frame_token,
            images,
            bytes: page.len(),
        })
    }

    /// True when `token` is the frame token this one render was published with.
    ///
    /// The access middleware is the only caller: it keeps the route shapes and the
    /// methods, and this answers the storage half. Only the digest is on disk and the
    /// comparison goes through digests, so a stolen folder hands out no capability
    /// and a wrong guess learns nothing. A render that was never published, one whose
    /// id could not have been written here, and another thread's folder all simply
    /// say no.
    pub fn render_frame_token_matches(
        &self,
        thread_id: &str,
        render_id: &str,
        token: &str,
    ) -> bool {
        if token.is_empty() || !is_render_id(render_id) || self.store.thread(thread_id).is_err() {
            return false;
        }
        let path = self
            .renders_root()
            .join(thread_id)
            .join(render_id)
            .join(FRAME_FILE);
        let Ok(stored) = std::fs::read_to_string(path) else {
            return false;
        };
        secrets_match(token, stored.trim())
    }

    /// The stored page of one render. Another thread's render id is simply not in
    /// this thread's folder, so it reads as not found.
    pub fn open_render_page(&self, thread_id: &str, render_id: &str) -> Result<RenderFile> {
        Ok(RenderFile {
            bytes: self.read_render(thread_id, render_id, PAGE_FILE, "render")?,
            content_type: PAGE_TYPE,
        })
    }

    /// One image the page embedded. Only the names this service writes are served,
    /// so no path separator or stray file in the folder can be reached.
    pub fn open_render_image(
        &self,
        thread_id: &str,
        render_id: &str,
        name: &str,
    ) -> Result<RenderFile> {
        let content_type = match name.split_once('.') {
            Some((_, extension)) if is_image_name(name) => image_type(extension),
            _ => None,
        }
        .ok_or_else(|| CoreError::NotFound("render image".into()))?;
        Ok(RenderFile {
            bytes: self.read_render(thread_id, render_id, name, "render image")?,
            content_type,
        })
    }

    fn read_render(
        &self,
        thread_id: &str,
        render_id: &str,
        file: &str,
        what: &str,
    ) -> Result<Vec<u8>> {
        let missing = || CoreError::NotFound(what.to_owned());
        // A thread must exist for its id to name anything, and an id this service
        // could not have written never reaches the filesystem.
        self.store.thread(thread_id).map_err(|_| missing())?;
        if !is_render_id(render_id) {
            return Err(missing());
        }
        let path = self
            .renders_root()
            .join(thread_id)
            .join(render_id)
            .join(file);
        if !std::fs::metadata(&path).is_ok_and(|meta| meta.is_file()) {
            return Err(missing());
        }
        std::fs::read(&path).map_err(|_| missing())
    }
}

impl Core {
    /// Removes every render a thread published. Called for each id `delete_thread`
    /// reports, so a side chat's renders go with its parent's.
    pub(crate) fn remove_renders(&self, thread_id: &str) {
        let _ = std::fs::remove_dir_all(self.renders_root().join(thread_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_src_is_found_in_every_quoting_and_attribute_order() {
        let html = "<IMG SRC = \"one.png\" alt=x><img alt=\"two\" src='two.png'>\
                    <img src=three.png width=1><img class=\"c\" src=\"/abs/four.png\">";
        let found = image_srcs(html);
        let values: Vec<&str> = found.iter().map(|it| it.src.as_str()).collect();
        assert_eq!(values, ["one.png", "two.png", "three.png", "/abs/four.png"]);
        // Each span is the value itself, quotes excluded.
        let spans: Vec<&str> = found.iter().map(|it| &html[it.start..it.end]).collect();
        assert_eq!(spans, values);
    }

    #[test]
    fn a_tag_that_only_looks_like_img_is_not_one() {
        assert!(image_srcs("<imgfoo src=\"a.png\">").is_empty());
        assert!(image_srcs("<image href=\"a.png\">").is_empty());
        assert!(image_srcs("<img>").is_empty());
        // An unfinished quoted value leaves the tag alone instead of guessing.
        assert!(image_srcs("<img src=\"a.png>").is_empty());
    }

    #[test]
    fn nothing_inside_script_style_or_a_comment_is_touched() {
        let html = "<script>const a = '<img src=\"in-script.png\">'</script>\
                    <style>/* <img src=in-style.png> */</style>\
                    <!-- <img src=\"in-comment.png\"> -->\
                    <img src=\"real.png\">\
                    <script src=\"app.js\"></script><img src=\"after.png\">";
        let found = image_srcs(html);
        let values: Vec<&str> = found.iter().map(|it| it.src.as_str()).collect();
        assert_eq!(values, ["real.png", "after.png"]);
    }

    #[test]
    fn embedding_rewrites_in_document_order_and_stops_at_the_limit() {
        let html = "<img src=\"a.png\"><img src='b.png'><img src=c.png> remote https://x/y.png";
        let mut asked = Vec::new();
        let (page, count) = embed_images(html, 2, &mut |src| {
            asked.push(src.to_owned());
            Some(format!("image-{}.png", asked.len()))
        });
        assert_eq!(count, 2);
        assert_eq!(asked, ["a.png", "b.png"]);
        assert_eq!(
            page,
            "<img src=\"image-1.png\"><img src='image-2.png'><img src=c.png> remote https://x/y.png"
        );
    }

    #[test]
    fn a_refused_src_stays_exactly_as_written() {
        let html = "<img src=\"../outside.png\"><img src='ok.png'>";
        let (page, count) = embed_images(html, MAX_RENDER_IMAGES, &mut |src| {
            (src == "ok.png").then(|| "image-1.png".to_owned())
        });
        assert_eq!(count, 1);
        assert_eq!(page, "<img src=\"../outside.png\"><img src='image-1.png'>");
    }

    #[test]
    fn only_checkout_paths_are_candidates() {
        // Built from the host's own root: a leading slash is not an absolute path on
        // Windows, so a hard-coded "/tmp/checkout" would test nothing there.
        let root = std::env::temp_dir();
        let checkout = root.join("checkout");
        let checkout = checkout.as_path();
        for candidate in ["./art/a.png", "art/a.png", "a.png"] {
            assert_eq!(
                checkout_relative(candidate, checkout).as_deref(),
                Some(candidate),
                "{candidate}"
            );
        }
        let inside = checkout.join("a.png");
        assert_eq!(
            checkout_relative(&inside.to_string_lossy(), checkout).as_deref(),
            Some("a.png")
        );
        let outside = root.join("elsewhere").join("a.png");
        assert_eq!(
            checkout_relative(&outside.to_string_lossy(), checkout),
            None
        );
        // An absolute path that leaves the checkout is refused, not repaired.
        let climbing = checkout.join("..").join("a.png");
        assert_eq!(
            checkout_relative(&climbing.to_string_lossy(), checkout),
            None
        );
        for remote in [
            "https://example.test/a.png",
            "HTTPS://example.test/a.png",
            "http://example.test/a.png",
            "//example.test/a.png",
            "data:image/png;base64,AAAA",
            "file:///tmp/checkout/a.png",
            "#top",
            "?q=1",
            "mailto:me@example.test",
        ] {
            assert_eq!(checkout_relative(remote, checkout), None, "{remote}");
        }
    }

    #[test]
    fn only_the_names_this_service_writes_are_served() {
        for good in [
            "image-1.png",
            "image-12.jpeg",
            "image-3.svg",
            "image-40.webp",
        ] {
            assert!(is_image_name(good), "{good}");
        }
        for bad in [
            "index.html",
            "image-.png",
            "image-x.png",
            "image-1.txt",
            "image-1.html",
            "image-1.png.html",
            "image-1",
            "image-1.PNG",
            "../image-1.png",
            "sub/image-1.png",
            "image-1.png/",
            "image-1..png",
            "image-1.avif.",
            "",
        ] {
            assert!(!is_image_name(bad), "{bad}");
        }
        assert!(is_render_id("01jc8xw9kq0000000000000000"));
        for bad in [
            "",
            "..",
            "R_1",
            "01JC8XW9KQ",
            "a/b",
            "a.b",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(!is_render_id(bad), "{bad}");
        }
    }

    #[test]
    fn the_caps_are_exact() {
        assert!(!html_too_large(MAX_RENDER_HTML_BYTES as usize));
        assert!(html_too_large(MAX_RENDER_HTML_BYTES as usize + 1));
        assert!(!image_too_large(MAX_RENDER_IMAGE_BYTES));
        assert!(image_too_large(MAX_RENDER_IMAGE_BYTES + 1));
        assert_eq!(MAX_RENDER_IMAGES, 32);
        assert_eq!(MAX_RENDERS_PER_THREAD, 20);
    }

    #[test]
    fn the_oldest_render_folder_is_the_one_evicted() {
        let dir = std::env::temp_dir().join(format!("orbyn-renders-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a", "b", "c"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        std::fs::write(dir.join("stray.txt"), "not a render").unwrap();
        evict_renders(&dir, 2);
        // "a" was made first, and the name breaks a tie when the clock is coarse.
        assert!(!dir.join("a").exists());
        assert!(dir.join("b").exists());
        assert!(dir.join("c").exists());
        assert!(dir.join("stray.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
