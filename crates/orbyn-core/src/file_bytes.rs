//! The bytes of a file in a thread's checkout, for images, media, PDFs and binary
//! views. A checkout holds code nobody here wrote, so a page in it must not run with
//! this service's origin: only formats on a short list are shown inline, and anything
//! else arrives as an opaque download. The type comes from the name and never from the
//! bytes, and clients are told not to sniff.

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::files::{inside, open_inside};

/// Past this a file is refused whole, which keeps a stray disk image out of a tab.
pub const MAX_RAW_BYTES: u64 = 1024 * 1024 * 1024;

const OPAQUE: &str = "application/octet-stream";

/// An open file, checked and ready to stream. The handle was validated, so serving it
/// cannot be redirected by a path swapped afterwards.
#[derive(Debug)]
pub struct RawFile {
    pub file: std::fs::File,
    pub name: String,
    pub size: u64,
    /// Changes when the file does; `If-Range` and `If-None-Match` compare it.
    pub tag: String,
    pub content_type: &'static str,
    /// False sends `Content-Disposition: attachment`.
    pub inline: bool,
    /// False only for a PDF, because a browser's PDF viewer refuses a sandboxed page.
    pub sandbox: bool,
}

/// The type for an extension, for formats that run no script in this origin. SVG
/// can hold script, so it is listed with the sandbox on, like everything else here.
fn inline_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

fn tag_of(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("\"{:x}-{modified:x}\"", meta.len())
}

impl Core {
    /// Opens a file under the same trust, `..`, link and `.git` checks as any other
    /// file route. `download` asks for an attachment whatever the type.
    pub fn open_raw_file(&self, thread_id: &str, path: &str, download: bool) -> Result<RawFile> {
        let (_, scope) = self.file_scope(thread_id)?;
        let full = inside(&scope, path)?;
        let meta = std::fs::metadata(&full).map_err(|_| CoreError::NotFound("file".into()))?;
        if !meta.is_file() {
            return Err(CoreError::Invalid("That path is not a file.".into()));
        }
        let (file, opened) = open_inside(&scope, path, &full)?;
        let size = opened.len();
        if size > MAX_RAW_BYTES {
            return Err(CoreError::FileTooLarge {
                size,
                limit: MAX_RAW_BYTES,
            });
        }
        let name = Path::new(path)
            .file_name()
            .map_or_else(|| "file".to_owned(), |n| n.to_string_lossy().into_owned());
        let extension = Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let known = inline_type(&extension);
        Ok(RawFile {
            file,
            name,
            size,
            tag: tag_of(&opened),
            content_type: known.unwrap_or(OPAQUE),
            inline: known.is_some() && !download,
            sandbox: extension != "pdf",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_that_runs_script_in_this_origin_is_listed() {
        for extension in [
            "html", "htm", "xhtml", "js", "mjs", "css", "xml", "json", "",
        ] {
            assert_eq!(inline_type(extension), None, "{extension}");
        }
    }
}
