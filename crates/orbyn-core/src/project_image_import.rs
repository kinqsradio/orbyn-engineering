//! A project image chosen outside the project, through the desktop app's own file
//! dialog. The service copies the file into its data directory, named by its content,
//! and the project keeps a reserved hint for that copy. A checkout hint can never take
//! that form, because checkout hints have no `.` component, so a project file can't be
//! mistaken for an imported image or the other way round. Nothing outside the data
//! directory is read again after the import.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::project_icons::{icns_png, media_type};
use crate::util::hex;

/// How a project records an imported image: this prefix, then `<sha256>.<extension>`.
pub(crate) const IMPORTED_PREFIX: &str = "./.orbyn-imported/";
/// The copies, under the service's data directory.
const DIRECTORY: &str = "project-images";
/// An icon needs no more; a larger file is refused rather than copied.
pub(crate) const IMPORT_LIMIT: u64 = 8 * 1024 * 1024;

/// The copy's file name, when `hint` is an imported image and well formed.
pub(crate) fn imported_name(hint: &str) -> Option<&str> {
    let name = hint.strip_prefix(IMPORTED_PREFIX)?;
    let (stem, extension) = name.split_once('.')?;
    let hashed = stem.len() == 64 && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let plain = !extension.is_empty()
        && extension.len() <= 5
        && extension
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    (hashed && plain && extension != "icns" && media_type(name).is_some()).then_some(name)
}

/// Whether the bytes are the kind of image the extension names. The file came from
/// outside every project, so its name alone is not trusted.
fn looks_like(extension: &str, bytes: &[u8]) -> bool {
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    match extension {
        "png" => at(0, b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => at(0, &[0xff, 0xd8, 0xff]),
        "gif" => at(0, b"GIF87a") || at(0, b"GIF89a"),
        "webp" => at(0, b"RIFF") && at(8, b"WEBP"),
        "avif" | "heic" | "heif" => at(4, b"ftyp"),
        "bmp" => at(0, b"BM"),
        "ico" => at(0, &[0, 0, 1, 0]),
        "tif" | "tiff" => at(0, b"II*\0") || at(0, b"MM\0*"),
        "svg" => std::str::from_utf8(bytes).is_ok_and(|text| {
            let head: String = text
                .chars()
                .take(4096)
                .collect::<String>()
                .to_ascii_lowercase();
            head.contains("<svg")
        }),
        _ => false,
    }
}

fn directory(data_dir: &Path) -> PathBuf {
    data_dir.join(DIRECTORY)
}

/// Copies the image at `source` into the data directory and returns the hint that
/// names the copy. The same image imported twice is one copy.
pub(crate) fn import(data_dir: &Path, source: &Path) -> Result<String> {
    if !source.is_absolute() {
        return Err(CoreError::Invalid("Choose an image file.".into()));
    }
    let metadata = std::fs::metadata(source)
        .map_err(|_| CoreError::Invalid("That image can't be opened.".into()))?;
    if !metadata.is_file() {
        return Err(CoreError::Invalid("Choose an image file.".into()));
    }
    if metadata.len() > IMPORT_LIMIT {
        return Err(CoreError::FileTooLarge {
            size: metadata.len(),
            limit: IMPORT_LIMIT,
        });
    }
    let unsupported = || {
        CoreError::Invalid(
            "Choose a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, ICNS, SVG, HEIC, HEIF or TIFF image."
                .into(),
        )
    };
    let mut extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(unsupported)?;
    if media_type(&format!("image.{extension}")).is_none() {
        return Err(unsupported());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(source)
        .map_err(|_| CoreError::Invalid("That image can't be opened.".into()))?
        .take(IMPORT_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > IMPORT_LIMIT {
        return Err(CoreError::FileTooLarge {
            size: bytes.len() as u64,
            limit: IMPORT_LIMIT,
        });
    }
    if extension == "icns" {
        // Kept as the PNG inside it, as a project's own ICNS is shown.
        bytes = icns_png(&bytes)
            .ok_or_else(|| CoreError::Invalid("That ICNS file has no PNG image inside.".into()))?;
        extension = "png".into();
    } else if extension == "jpeg" {
        extension = "jpg".into();
    } else if extension == "tif" {
        extension = "tiff".into();
    }
    if !looks_like(&extension, &bytes) {
        return Err(CoreError::Invalid(
            "That file is not the kind of image its name says.".into(),
        ));
    }
    let name = format!("{}.{extension}", hex(&Sha256::digest(&bytes)));
    let folder = directory(data_dir);
    std::fs::create_dir_all(&folder)?;
    let target = folder.join(&name);
    if !target.is_file() {
        // Written beside the target, then renamed, so a reader never sees half a copy.
        let staging = folder.join(format!(".incoming-{}", crate::util::new_id()));
        std::fs::write(&staging, &bytes)?;
        if let Err(error) = std::fs::rename(&staging, &target) {
            let _ = std::fs::remove_file(&staging);
            if !target.is_file() {
                return Err(error.into());
            }
        }
    }
    Ok(format!("{IMPORTED_PREFIX}{name}"))
}

/// Opens an imported copy for reading, or `None` when it is gone or not a plain file.
pub(crate) fn open(
    data_dir: &Path,
    name: &str,
) -> Result<Option<(std::fs::File, std::fs::Metadata)>> {
    let path = directory(data_dir).join(name);
    let Ok(link) = std::fs::symlink_metadata(&path) else {
        return Ok(None);
    };
    if !link.is_file() || link.len() > IMPORT_LIMIT {
        return Ok(None);
    }
    let file = std::fs::File::open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != link.len() {
        return Ok(None);
    }
    Ok(Some((file, metadata)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn dir() -> Dir {
        let path = std::env::temp_dir().join(format!("orbyn-import-{}", crate::util::new_id()));
        std::fs::create_dir_all(&path).unwrap();
        Dir(path)
    }

    #[test]
    fn an_image_is_copied_once_under_its_content_name() {
        let (data, outside) = (dir(), dir());
        let source = outside.0.join("Logo.PNG");
        std::fs::write(&source, PNG).unwrap();
        let hint = import(&data.0, &source).unwrap();
        let name = imported_name(&hint).expect("a well-formed hint");
        assert_eq!(name, format!("{}.png", hex(&Sha256::digest(PNG))));
        assert_eq!(
            std::fs::read(data.0.join(DIRECTORY).join(name)).unwrap(),
            PNG
        );
        // The copy no longer depends on the original.
        std::fs::remove_file(&source).unwrap();
        assert!(open(&data.0, name).unwrap().is_some());
        let again = outside.0.join("copy.png");
        std::fs::write(&again, PNG).unwrap();
        assert_eq!(import(&data.0, &again).unwrap(), hint);
        assert_eq!(
            std::fs::read_dir(data.0.join(DIRECTORY)).unwrap().count(),
            1
        );
    }

    #[test]
    fn a_wrong_kind_a_large_file_or_a_folder_is_refused() {
        let (data, outside) = (dir(), dir());
        let fake = outside.0.join("fake.png");
        std::fs::write(&fake, b"not an image").unwrap();
        assert!(matches!(import(&data.0, &fake), Err(CoreError::Invalid(_))));
        let text = outside.0.join("notes.txt");
        std::fs::write(&text, PNG).unwrap();
        assert!(matches!(import(&data.0, &text), Err(CoreError::Invalid(_))));
        let large = outside.0.join("large.png");
        let mut bytes = PNG.to_vec();
        bytes.resize(IMPORT_LIMIT as usize + 1, 0);
        std::fs::write(&large, bytes).unwrap();
        assert!(matches!(
            import(&data.0, &large),
            Err(CoreError::FileTooLarge { .. })
        ));
        let folder = outside.0.join("folder.png");
        std::fs::create_dir(&folder).unwrap();
        assert!(matches!(
            import(&data.0, &folder),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            import(&data.0, Path::new("relative.png")),
            Err(CoreError::Invalid(_))
        ));
        assert!(
            !data.0.join(DIRECTORY).exists()
                || std::fs::read_dir(data.0.join(DIRECTORY)).unwrap().count() == 0
        );
    }

    #[test]
    fn an_svg_must_be_text_with_an_svg_element() {
        let (data, outside) = (dir(), dir());
        let good = outside.0.join("mark.svg");
        std::fs::write(
            &good,
            "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        assert!(import(&data.0, &good).unwrap().ends_with(".svg"));
        let bad = outside.0.join("bad.svg");
        std::fs::write(&bad, "<html></html>").unwrap();
        assert!(import(&data.0, &bad).is_err());
    }

    #[test]
    fn only_the_reserved_form_names_an_import() {
        let name = format!("{}.png", "a".repeat(64));
        assert_eq!(
            imported_name(&format!("{IMPORTED_PREFIX}{name}")),
            Some(name.as_str())
        );
        for hint in [
            format!(".orbyn-imported/{name}"),
            format!("{IMPORTED_PREFIX}{}.png", "A".repeat(64)),
            format!("{IMPORTED_PREFIX}{}.png", "a".repeat(63)),
            format!("{IMPORTED_PREFIX}{}.exe", "a".repeat(64)),
            format!("{IMPORTED_PREFIX}../{name}"),
            "logo.png".to_owned(),
        ] {
            assert_eq!(imported_name(&hint), None, "{hint}");
        }
        // A checkout hint can never take the reserved form.
        assert!(
            crate::project_image_picker::validate_hint(&format!("{IMPORTED_PREFIX}{name}"))
                .is_err()
        );
    }

    #[test]
    fn a_missing_or_linked_copy_is_not_opened() {
        let data = dir();
        let name = format!("{}.png", "b".repeat(64));
        assert!(open(&data.0, &name).unwrap().is_none());
        #[cfg(unix)]
        {
            let outside = dir();
            let real = outside.0.join("real.png");
            std::fs::write(&real, PNG).unwrap();
            std::fs::create_dir_all(data.0.join(DIRECTORY)).unwrap();
            std::os::unix::fs::symlink(&real, data.0.join(DIRECTORY).join(&name)).unwrap();
            assert!(open(&data.0, &name).unwrap().is_none());
        }
    }
}
