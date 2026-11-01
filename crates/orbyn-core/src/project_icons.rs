//! Passive image reads for registered physical projects. No thread, execution,
//! external image grant, or ordinary file authority is created by this owner.
use std::path::{Path, PathBuf};

use base64::Engine;
use orbyn_contracts::{
    Project, ProjectIconImage, ProjectIconImageData, ProjectIconMediaType, ProjectIconSource,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::app::Core;
use crate::approvals::WriteScope;
use crate::error::{CoreError, Result};
use crate::files::{inside, open_inside, opened_path};
use crate::project_file::{FILE_NAMES, parse_project_text};
use crate::util::canonicalize;
use crate::workspace::guard_library;

const IMAGE_LIMIT: usize = 1024 * 1024;
const TEXT_LIMIT: usize = 256 * 1024;
const SOURCE_BUDGET: usize = 2 * 1024 * 1024;
const ICNS_PREFERRED_WIDTH: u32 = 96;

// Ordered reference behavior data, not executable project configuration.
const CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
    "Resources/AppIcon.icns",
    "AppIcon.icns",
];
const SOURCES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

#[derive(Clone, Copy)]
enum ReadKind {
    Text,
    Image,
}

struct CheckedBytes {
    bytes: Vec<u8>,
    relative_path: String,
}

struct ImageScope {
    files: WriteScope,
    library: PathBuf,
    source_budget: usize,
}

impl ImageScope {
    fn new(project: &Project, library: &Path) -> Result<Self> {
        if project.scratch {
            return Err(CoreError::NotFound("project".into()));
        }
        let stored = Path::new(&project.path);
        let root = canonicalize(stored)?;
        if root != stored || !root.is_dir() {
            return Err(CoreError::StaleOwner);
        }
        guard_library(library, &root)?;
        Ok(Self {
            files: WriteScope {
                checkout: root.clone(),
                engine_cwd: root,
                excluded: vec![],
            },
            library: library.to_owned(),
            source_budget: SOURCE_BUDGET,
        })
    }

    fn opened_relative(
        &self,
        file: &std::fs::File,
        requested: &str,
        kind: ReadKind,
    ) -> Option<String> {
        let actual = opened_path(file).ok()?;
        if !actual.is_absolute()
            || canonicalize(&self.files.checkout).ok()? != self.files.checkout
            || guard_library(&self.library, &actual).is_err()
        {
            return None;
        }
        let relative = actual.strip_prefix(&self.files.checkout).ok()?;
        if relative.as_os_str().is_empty()
            || relative.components().any(|part| match part {
                std::path::Component::Normal(name) => {
                    name.to_string_lossy().eq_ignore_ascii_case(".git")
                }
                _ => true,
            })
        {
            return None;
        }
        match kind {
            ReadKind::Text if actual != self.files.checkout.join(requested) => return None,
            ReadKind::Image if media_type(&relative.to_string_lossy()).is_none() => return None,
            _ => {}
        }
        Some(relative.to_str()?.replace('\\', "/"))
    }

    async fn read(
        &mut self,
        relative: &str,
        limit: usize,
        kind: ReadKind,
    ) -> Result<Option<CheckedBytes>> {
        // Paths supplied by the project file/source are hints, never grants.
        let Ok(full) = inside(&self.files, relative) else {
            return Ok(None);
        };
        let Some(real) = crate::approvals::resolve_existing(&full) else {
            return Ok(None);
        };
        if !real.starts_with(&self.files.checkout) || guard_library(&self.library, &real).is_err() {
            return Ok(None);
        }
        let Ok(meta) = std::fs::metadata(&real) else {
            return Ok(None);
        };
        if !meta.is_file() || meta.len() > limit as u64 {
            return Ok(None);
        }
        let Ok((file, opened)) = open_inside(&self.files, relative, &real) else {
            return Ok(None);
        };
        if opened.len() > limit as u64 {
            return Ok(None);
        }
        // The pre-open path is insufficient: parent directories may change
        // between that check and open. Only the actual handle authorizes bytes.
        let Some(relative_path) = self.opened_relative(&file, relative, kind) else {
            return Ok(None);
        };
        let mut reader = tokio::fs::File::from_std(file.try_clone()?);
        let bytes = bounded_read(&mut reader, limit).await?;
        if matches!(kind, ReadKind::Text) {
            self.source_budget -= bytes.len();
        }
        if self.opened_relative(&file, relative, kind).as_deref() != Some(relative_path.as_str()) {
            return Ok(None);
        }
        Ok(Some(CheckedBytes {
            bytes,
            relative_path,
        }))
    }

    async fn text(&mut self, relative: &str) -> Result<Option<String>> {
        if self.source_budget <= 1 {
            return Ok(None);
        }
        let limit = TEXT_LIMIT.min(self.source_budget - 1);
        let Some(checked) = self.read(relative, limit, ReadKind::Text).await? else {
            return Ok(None);
        };
        if checked.bytes.len() > limit {
            return Ok(None);
        }
        Ok(String::from_utf8(checked.bytes).ok())
    }

    async fn image(
        &mut self,
        path: &str,
        source: ProjectIconSource,
    ) -> Result<Option<ProjectIconImageData>> {
        if media_type(path).is_none() {
            return Ok(None);
        }
        let Some(checked) = self.read(path, IMAGE_LIMIT, ReadKind::Image).await? else {
            return Ok(None);
        };
        let Some((media_type, mime)) = media_type(&checked.relative_path) else {
            return Ok(None);
        };
        let mut bytes = checked.bytes;
        if bytes.len() > IMAGE_LIMIT {
            return Ok(None);
        }
        if Path::new(&checked.relative_path)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("icns"))
        {
            let Some(png) = icns_png(&bytes) else {
                return Ok(None);
            };
            bytes = png;
        }
        let mut digest = Sha256::new();
        digest.update(mime.as_bytes());
        digest.update([0]);
        digest.update(&bytes);
        let revision = format!("{:x}", digest.finalize());
        Ok(Some(ProjectIconImageData {
            source,
            relative_path: checked.relative_path,
            revision,
            media_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }))
    }

    async fn resolve(&mut self) -> Result<Option<ProjectIconImageData>> {
        // The first present project file owns the hint, even if it is malformed,
        // denied or too large. Never read it through the legacy path reader.
        for name in FILE_NAMES {
            let Ok(metadata) = std::fs::symlink_metadata(self.files.checkout.join(name)) else {
                continue;
            };
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                continue;
            }
            if let Some(text) = self.text(name).await?
                && let Ok(project_file) = parse_project_text(&text)
                && let Some(path) = project_file.icon_path
                && let Some(image) = self.image(&path, ProjectIconSource::ProjectFile).await?
            {
                return Ok(Some(image));
            }
            break;
        }
        for path in CANDIDATES {
            if let Some(image) = self.image(path, ProjectIconSource::Automatic).await? {
                return Ok(Some(image));
            }
        }
        for source in SOURCES {
            let Some(text) = self.text(source).await? else {
                continue;
            };
            let Some(href) = icon_href(&text) else {
                continue;
            };
            let href = href.split('?').next().unwrap_or_default();
            if href.contains(':') || href.starts_with("//") || href.contains('\\') {
                continue;
            }
            let local = href.strip_prefix('/').unwrap_or(href);
            for path in [format!("public/{local}"), local.to_owned()] {
                if let Some(image) = self.image(&path, ProjectIconSource::Automatic).await? {
                    return Ok(Some(image));
                }
            }
        }
        Ok(None)
    }
}

async fn bounded_read(reader: &mut (impl AsyncRead + Unpin), limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

fn media_type(path: &str) -> Option<(ProjectIconMediaType, &'static str)> {
    use ProjectIconMediaType::*;
    Some(
        match Path::new(path)
            .extension()?
            .to_str()?
            .to_ascii_lowercase()
            .as_str()
        {
            "png" | "icns" => (Png, "image/png"),
            "jpg" | "jpeg" => (Jpeg, "image/jpeg"),
            "gif" => (Gif, "image/gif"),
            "webp" => (Webp, "image/webp"),
            "avif" => (Avif, "image/avif"),
            "bmp" => (Bmp, "image/bmp"),
            "ico" => (Ico, "image/x-icon"),
            "svg" => (Svg, "image/svg+xml"),
            "heic" => (Heic, "image/heic"),
            "heif" => (Heif, "image/heif"),
            "tif" | "tiff" => (Tiff, "image/tiff"),
            _ => return None,
        },
    )
}

// Extract only quoted attributes/metadata values. This never evaluates source,
// expands entities, parses a URL, or resolves external resources.
fn quoted_field<'a>(text: &'a str, key: &str, separator: u8) -> Option<&'a str> {
    let bytes = text.as_bytes();
    for (at, _) in text.char_indices() {
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
            continue;
        }
        let Some(name) = bytes.get(at..at + key.len()) else {
            continue;
        };
        if !name.eq_ignore_ascii_case(key.as_bytes()) {
            continue;
        }
        let mut cursor = at + key.len();
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&separator) {
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let quote = *bytes.get(cursor)?;
        if !matches!(quote, b'\'' | b'"') {
            continue;
        }
        let start = cursor + 1;
        let length = bytes.get(start..)?.iter().position(|byte| *byte == quote)?;
        return text.get(start..start + length);
    }
    None
}

fn icon_href(text: &str) -> Option<&str> {
    for tag in text.split('<').skip(1) {
        let Some(prefix) = tag.get(..4) else {
            continue;
        };
        if !prefix.eq_ignore_ascii_case("link")
            || !tag.as_bytes().get(4).is_some_and(u8::is_ascii_whitespace)
        {
            continue;
        }
        let tag = tag.split('>').next()?;
        if quoted_field(tag, "rel", b'=').is_some_and(|rel| {
            rel.eq_ignore_ascii_case("icon") || rel.eq_ignore_ascii_case("shortcut icon")
        }) && let Some(href) = quoted_field(tag, "href", b'=')
        {
            return Some(href);
        }
    }
    for object in text.split('}') {
        if quoted_field(object, "rel", b':').is_some_and(|rel| {
            rel.eq_ignore_ascii_case("icon") || rel.eq_ignore_ascii_case("shortcut icon")
        }) && let Some(href) = quoted_field(object, "href", b':')
        {
            return Some(href);
        }
    }
    None
}

fn icns_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.get(..4)? != b"icns" {
        return None;
    }
    let number = |at: usize| {
        Some(u32::from_be_bytes(
            bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
        ))
    };
    let end = usize::try_from(number(4)?).ok()?.min(bytes.len());
    if end < 8 {
        return None;
    }
    let mut cursor = 8usize;
    let mut selected: Option<(u32, &[u8])> = None;
    while cursor.checked_add(8)? <= end {
        let length = usize::try_from(number(cursor + 4)?).ok()?;
        if length < 8 {
            break;
        }
        let next = cursor.checked_add(length)?;
        if next > end {
            break;
        }
        let payload = bytes.get(cursor + 8..next)?;
        cursor = next;
        if !payload.starts_with(b"\x89PNG\r\n\x1a\n") || payload.get(12..16) != Some(b"IHDR") {
            continue;
        }
        let Some(width_bytes) = payload.get(16..20) else {
            continue;
        };
        let width = u32::from_be_bytes(width_bytes.try_into().ok()?);
        if width == 0 {
            continue;
        }
        let rank = |width: u32| {
            if width >= ICNS_PREFERRED_WIDTH {
                (0, width)
            } else {
                (1, u32::MAX - width)
            }
        };
        if selected.is_none_or(|(prior, _)| rank(width) < rank(prior)) {
            selected = Some((width, payload));
        }
    }
    selected.map(|(_, png)| png.to_owned())
}

impl Core {
    pub async fn project_icon(&self, project_id: &str) -> Result<ProjectIconImage> {
        let _library_reader = self.workspace.library_reader().await;
        let library = self.workspace.root()?;
        let project = self.store.project(project_id)?;
        let mut scope = ImageScope::new(&project, &library)?;
        let image = scope.resolve().await?;
        let current = self.store.project(project_id)?;
        if current.path != project.path
            || current.scratch
            || canonicalize(Path::new(&project.path))? != scope.files.checkout
        {
            return Err(CoreError::StaleOwner);
        }
        Ok(ProjectIconImage {
            project_id: project.id,
            project_path: project.path,
            image,
        })
    }
}

#[cfg(test)]
mod tests;
