//! Files outside a thread's checkout that the person opens to look at, such as an
//! absolute path in a message. Core decides; the service only routes. The view is
//! read-only: there is no write, rename, delete or folder listing here, and no
//! engine tool reaches it. The path is canonicalized, links resolved, before the
//! decision, and the opened handle is checked again.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use orbyn_contracts::OutsideFile;

use crate::app::Core;
use crate::error::{CoreError, Result};

/// The same cap as a checkout read.
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 4096;
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn refused(message: &str) -> CoreError {
    CoreError::Invalid(message.into())
}

/// True for a path that names another machine or a device, read from the text
/// alone: on Windows `\\server\share`, `\\?\UNC\…`, `\\.\…`; on macOS the `/net`
/// and `/Network` automounts. Touching one contacts a host a message named, and on
/// Windows sends the person's network credentials there.
#[cfg(windows)]
pub(crate) fn names_remote(path: &Path) -> bool {
    use std::path::Prefix;
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        }
        _ => false,
    }
}

#[cfg(not(windows))]
pub(crate) fn names_remote(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let mut parts = path.components();
    matches!(parts.next(), Some(Component::RootDir))
        && parts.next().is_some_and(|part| {
            let name = part.as_os_str().to_string_lossy().to_lowercase();
            name == "net" || name == "network"
        })
}

/// Links followed before giving up, like the systems' own limits.
const MAX_LINK_HOPS: u32 = 32;

/// True when `path`, or any link along it, names another machine. The path is
/// resolved here one part at a time, the way the system would: `..` steps back from
/// the folder actually reached and a link is read, never followed. Each folder is
/// judged before it is looked at, so `/x/../net/host` or a link to a share is caught
/// before anything contacts the host.
pub(crate) fn reaches_remote(path: &Path) -> bool {
    if names_remote(path) {
        return true;
    }
    let mut pending: Vec<PathBuf> = path
        .components()
        .rev()
        .map(|part| PathBuf::from(part.as_os_str()))
        .collect();
    let mut reached = PathBuf::new();
    let mut hops = 0;
    while let Some(next) = pending.pop() {
        let Some(part) = next.components().next() else {
            continue;
        };
        match part {
            Component::CurDir => continue,
            Component::ParentDir => {
                // `reached` holds no links, so stepping back by name is exact.
                reached.pop();
                continue;
            }
            Component::Prefix(_) | Component::RootDir => {
                if matches!(part, Component::Prefix(_)) {
                    reached = PathBuf::new();
                }
                reached.push(part.as_os_str());
                if names_remote(&reached) {
                    return true;
                }
                continue;
            }
            Component::Normal(_) => {}
        }
        let candidate = reached.join(part.as_os_str());
        if names_remote(&candidate) {
            return true;
        }
        let Ok(meta) = std::fs::symlink_metadata(&candidate) else {
            // Nothing further exists; resolving fails without contacting anyone.
            return false;
        };
        if !meta.file_type().is_symlink() {
            reached = candidate;
            continue;
        }
        hops += 1;
        if hops > MAX_LINK_HOPS {
            return true;
        }
        let Ok(target) = std::fs::read_link(&candidate) else {
            return true;
        };
        if names_remote(&target) {
            return true;
        }
        if target.has_root() {
            reached = PathBuf::new();
        }
        pending.extend(
            target
                .components()
                .rev()
                .map(|part| PathBuf::from(part.as_os_str())),
        );
    }
    false
}

/// One component in the form compared: a drive prefix with or without `\\?\` is
/// the same drive, and Windows and macOS disks ignore case by default.
fn folded(part: Component<'_>) -> String {
    #[cfg(windows)]
    if let Component::Prefix(prefix) = part {
        use std::path::Prefix;
        if let Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) = prefix.kind() {
            return format!("{}:", char::from(drive).to_ascii_lowercase());
        }
    }
    let text = part.as_os_str().to_string_lossy();
    if cfg!(any(windows, target_os = "macos")) {
        text.to_lowercase()
    } else {
        text.into_owned()
    }
}

/// Whether `path` is `root` or below it, whole components at a time.
fn within(path: &Path, root: &Path) -> bool {
    let fold = |path: &Path| -> Vec<String> {
        path.components()
            .filter(|part| !matches!(part, Component::CurDir))
            .map(folded)
            .collect()
    };
    let (path, root) = (fold(path), fold(root));
    path.len() >= root.len() && path[..root.len()] == root[..]
}

/// How many names the open file has. A second name can sit outside the fence while
/// the file lives inside it, and the handle reports only the name it was opened by.
#[cfg(unix)]
fn link_count(file: &std::fs::File) -> std::io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

#[cfg(windows)]
fn link_count(file: &std::fs::File) -> std::io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: the handle stays owned by file; the struct is plain data the call fills.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: a live handle and a writable struct of the expected type.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(u64::from(info.nNumberOfLinks))
}

#[cfg(not(any(unix, windows)))]
fn link_count(_: &std::fs::File) -> std::io::Result<u64> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// The places this view never shows, canonicalized: the thread's checkout, whose
/// files go through the checkout routes and their rules, and Orbyn's own data,
/// which holds the service token and every thread's records.
struct Fence {
    checkout: PathBuf,
    data: PathBuf,
}

impl Fence {
    fn new(checkout: &Path, data: &Path) -> Result<Self> {
        let canonical = |path: &Path| {
            crate::util::canonicalize(path).map_err(|_| refused("This checkout is unavailable."))
        };
        Ok(Self {
            checkout: canonical(checkout)?,
            data: canonical(data)?,
        })
    }

    fn check(&self, path: &Path) -> Result<()> {
        if names_remote(path) {
            return Err(refused("Orbyn doesn't open files on another computer."));
        }
        if within(path, &self.checkout) {
            return Err(refused(
                "That file is in this checkout. Open it from Files.",
            ));
        }
        if within(path, &self.data) {
            return Err(refused("Orbyn's own data isn't shown here."));
        }
        Ok(())
    }
}

/// The canonical file `raw` names, or a refusal. Only a full path is accepted, so
/// nothing is resolved against a folder the request did not name.
fn target_of(raw: &str, fence: &Fence) -> Result<PathBuf> {
    if raw.is_empty() || raw.chars().count() > MAX_PATH_CHARS || raw.contains('\0') {
        return Err(refused("Open a file by its full path."));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(refused("Open a file by its full path."));
    }
    // Refuse a remote name, or a link to one, before canonicalize touches it.
    if reaches_remote(path) {
        return Err(refused("Orbyn doesn't open files on another computer."));
    }
    let resolved =
        crate::util::canonicalize(path).map_err(|_| CoreError::NotFound("file".into()))?;
    fence.check(&resolved)?;
    Ok(resolved)
}

/// Opens `target` without following a link at the last step, then checks the path
/// the handle actually names, so a folder swapped for a link after the first check
/// cannot point this read into the checkout or Orbyn's data.
fn read_target(target: &Path, fence: &Fence) -> Result<OutsideFile> {
    // Windows will not open a folder as a file, so judge the kind first; the handle is
    // checked again below for anything that changed in between.
    match std::fs::metadata(target) {
        Ok(meta) if meta.is_dir() => return Err(refused("That path is not a file.")),
        Ok(_) => {}
        Err(_) => return Err(CoreError::NotFound("file".into())),
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(target)
        .map_err(|_| CoreError::NotFound("file".into()))?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        // A folder is never listed from here.
        return Err(refused("That path is not a file."));
    }
    let opened =
        crate::files::opened_path(&file).map_err(|_| refused("That file can't be checked."))?;
    if !within(&opened, target) || !within(target, &opened) {
        return Err(refused("That file moved while it was opened."));
    }
    fence.check(&opened)?;
    if link_count(&file).map_or(true, |count| count != 1) {
        return Err(refused(
            "That file has more than one name, so Orbyn can't tell where it lives.",
        ));
    }
    let size = meta.len();
    let path = target.to_string_lossy().into_owned();
    let mut bytes = Vec::new();
    if size <= MAX_READ_BYTES {
        file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes)?;
    }
    // A file that grew past the cap while it was read counts as too large too.
    let truncated = size > MAX_READ_BYTES || bytes.len() as u64 > MAX_READ_BYTES;
    if truncated {
        return Ok(OutsideFile {
            path,
            content: String::new(),
            size: size.max(bytes.len() as u64),
            binary: false,
            truncated: true,
            outside: true,
            read_only: true,
        });
    }
    let text = String::from_utf8(bytes);
    let binary = text.is_err();
    Ok(OutsideFile {
        path,
        content: text.unwrap_or_default(),
        size,
        binary,
        truncated: false,
        outside: true,
        read_only: true,
    })
}

impl Core {
    /// Reads a file outside the thread's checkout for the person to look at. The
    /// folder must be trusted like any file route; nothing here writes.
    pub async fn read_outside_file(&self, thread_id: &str, path: &str) -> Result<OutsideFile> {
        let (_, scope) = self.file_scope(thread_id)?;
        let (checkout, data, path) = (
            scope.checkout.clone(),
            self.config.data_dir.clone(),
            path.to_owned(),
        );
        // A slow or hung disk holds one blocking thread, never the service's runtime.
        let read = tokio::task::spawn_blocking(move || {
            let fence = Fence::new(&checkout, &data)?;
            let target = target_of(&path, &fence)?;
            read_target(&target, &fence)
        });
        match tokio::time::timeout(READ_TIMEOUT, read).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CoreError::Internal("The read stopped.".into())),
            Err(_) => Err(refused("That file took too long to read.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: crate::testing::TempDir,
        root: PathBuf,
        fence: Fence,
    }

    fn fixture() -> Fixture {
        let dir = crate::testing::TempDir::new();
        let root = crate::util::canonicalize(dir.path()).unwrap();
        for folder in ["checkout", "data", "elsewhere"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        let fence = Fence::new(&root.join("checkout"), &root.join("data")).unwrap();
        Fixture {
            _dir: dir,
            root,
            fence,
        }
    }

    fn read(fixture: &Fixture, raw: &Path) -> Result<OutsideFile> {
        let target = target_of(&raw.to_string_lossy(), &fixture.fence)?;
        read_target(&target, &fixture.fence)
    }

    #[test]
    fn an_outside_file_reads_marked_outside_and_read_only() {
        let fixture = fixture();
        let file = fixture.root.join("elsewhere/notes.md");
        std::fs::write(&file, "# hi").unwrap();
        let read = read(&fixture, &file).unwrap();
        assert_eq!(read.content, "# hi");
        assert!(read.outside && read.read_only && !read.binary && !read.truncated);
        assert_eq!(Path::new(&read.path), file);
    }

    #[test]
    fn only_a_full_path_is_accepted() {
        let fixture = fixture();
        for raw in ["", "notes.md", "../elsewhere/notes.md", "./x", "a\0b"] {
            assert!(target_of(raw, &fixture.fence).is_err(), "{raw:?}");
        }
    }

    #[test]
    fn dot_dot_into_the_checkout_is_refused_after_canonicalizing() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("checkout/a.txt"), "in").unwrap();
        let sneaky = fixture.root.join("elsewhere/../checkout/a.txt");
        let error = read(&fixture, &sneaky).unwrap_err();
        assert!(error.to_string().contains("in this checkout"), "{error}");
    }

    #[test]
    fn orbyn_data_is_never_shown() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("data/token"), "secret").unwrap();
        let error = read(&fixture, &fixture.root.join("data/token")).unwrap_err();
        assert!(error.to_string().contains("own data"), "{error}");
    }

    #[test]
    fn a_folder_is_not_listed() {
        let fixture = fixture();
        let error = read(&fixture, &fixture.root.join("elsewhere")).unwrap_err();
        assert!(error.to_string().contains("not a file"), "{error}");
    }

    #[test]
    fn a_large_file_is_reported_without_its_bytes() {
        let fixture = fixture();
        let file = fixture.root.join("elsewhere/big.log");
        let handle = std::fs::File::create(&file).unwrap();
        handle.set_len(MAX_READ_BYTES + 1).unwrap();
        let read = read(&fixture, &file).unwrap();
        assert!(read.truncated && read.content.is_empty());
        assert_eq!(read.size, MAX_READ_BYTES + 1);
    }

    #[test]
    fn binary_bytes_are_flagged_not_decoded() {
        let fixture = fixture();
        let file = fixture.root.join("elsewhere/blob.bin");
        std::fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
        let read = read(&fixture, &file).unwrap();
        assert!(read.binary && read.content.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_judged_where_it_lands() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("checkout/secret.txt"), "in").unwrap();
        std::fs::write(fixture.root.join("data/token"), "t").unwrap();
        std::fs::write(fixture.root.join("elsewhere/real.txt"), "out").unwrap();
        let links = fixture.root.join("elsewhere");
        std::os::unix::fs::symlink(fixture.root.join("checkout/secret.txt"), links.join("in"))
            .unwrap();
        std::os::unix::fs::symlink(fixture.root.join("data"), links.join("data")).unwrap();
        std::os::unix::fs::symlink(links.join("real.txt"), links.join("ok")).unwrap();
        assert!(read(&fixture, &links.join("in")).is_err());
        assert!(read(&fixture, &links.join("data/token")).is_err());
        let ok = read(&fixture, &links.join("ok")).unwrap();
        assert_eq!(ok.content, "out");
        assert_eq!(Path::new(&ok.path), links.join("real.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let fixture = fixture();
        let fifo = fixture.root.join("elsewhere/pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: name owns a NUL-terminated path for the duration of mkfifo.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read(&fixture, &fifo).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_second_name_for_a_fenced_file_is_refused() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("data/service.json"), "token").unwrap();
        let alias = fixture.root.join("elsewhere/copy.json");
        std::fs::hard_link(fixture.root.join("data/service.json"), &alias).unwrap();
        let error = read(&fixture, &alias).unwrap_err();
        assert!(error.to_string().contains("more than one name"), "{error}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_macos_automount_is_refused_without_resolving_it() {
        let fixture = fixture();
        assert!(names_remote(Path::new("/net/host.invalid/share/a.txt")));
        assert!(names_remote(Path::new("/Network/Servers/x")));
        assert!(!names_remote(Path::new("/network-notes/a.txt")));
        let link = fixture.root.join("elsewhere/share");
        std::os::unix::fs::symlink("/net/host.invalid/share", &link).unwrap();
        assert!(reaches_remote(&link.join("a.txt")));
        let error = target_of(&link.join("a.txt").to_string_lossy(), &fixture.fence).unwrap_err();
        assert!(error.to_string().contains("another computer"), "{error}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dot_dot_into_an_automount_is_caught_where_it_lands() {
        let fixture = fixture();
        for raw in [
            "/Users/../net/host.invalid/x",
            "/../net/host.invalid/x",
            "/private/../Network/Servers/x",
        ] {
            assert!(reaches_remote(Path::new(raw)), "{raw}");
            let error = target_of(raw, &fixture.fence).unwrap_err();
            assert!(
                error.to_string().contains("another computer"),
                "{raw}: {error}"
            );
        }
        // A relative link whose `..` climbs to the automount.
        let deep = fixture.root.join("elsewhere");
        let climb = "../".repeat(deep.components().count() - 1);
        std::os::unix::fs::symlink(format!("{climb}net/host.invalid"), deep.join("up")).unwrap();
        assert!(reaches_remote(&deep.join("up/x")));
        // `..` after a link steps back from where the link landed, not by name.
        std::fs::create_dir_all(fixture.root.join("elsewhere/real/inner")).unwrap();
        std::os::unix::fs::symlink(fixture.root.join("elsewhere/real/inner"), deep.join("in"))
            .unwrap();
        assert!(!reaches_remote(&deep.join("in/../inner")));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_loop_stops() {
        let fixture = fixture();
        let dir = fixture.root.join("elsewhere");
        std::os::unix::fs::symlink(dir.join("b"), dir.join("a")).unwrap();
        std::os::unix::fs::symlink(dir.join("a"), dir.join("b")).unwrap();
        assert!(read(&fixture, &dir.join("a")).is_err());
    }

    #[test]
    fn within_matches_whole_components() {
        let root = Path::new("/a/checkout");
        assert!(within(Path::new("/a/checkout"), root));
        assert!(within(Path::new("/a/checkout/x"), root));
        assert!(!within(Path::new("/a/checkout-two/x"), root));
        assert!(!within(Path::new("/a"), root));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn a_different_case_of_the_checkout_is_still_the_checkout() {
        assert!(within(Path::new("/A/CheckOut/x"), Path::new("/a/checkout")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_forms() {
        // Drive letters, either slash and either case are local paths.
        for local in [
            r"C:\Users\x\a.txt",
            "c:/Users/x/a.txt",
            r"\\?\C:\Users\x\a.txt",
        ] {
            assert!(Path::new(local).is_absolute(), "{local}");
            assert!(!names_remote(Path::new(local)), "{local}");
        }
        // Another machine or a device is refused before it is touched.
        for remote in [
            r"\\server\share\a.txt",
            r"\\?\UNC\server\share\a.txt",
            r"\\.\pipe\x",
            r"\\localhost\C$\a.txt",
        ] {
            assert!(names_remote(Path::new(remote)), "{remote}");
        }
        let fixture = fixture();
        for remote in [r"\\server\share\a.txt", r"\\?\UNC\server\share\a.txt"] {
            let error = target_of(remote, &fixture.fence).unwrap_err();
            assert!(error.to_string().contains("another computer"), "{error}");
        }
        // Drive-relative and rooted forms name no single file.
        for relative in [r"C:a.txt", r"\Users\x\a.txt"] {
            assert!(target_of(relative, &fixture.fence).is_err(), "{relative}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn streams_and_device_names_never_reach_fenced_or_device_bytes() {
        let fixture = fixture();
        // A stream of a checkout file is still the checkout file.
        let inside = fixture.root.join("checkout/a.txt");
        std::fs::write(&inside, "in").unwrap();
        let stream = format!("{}:hidden", inside.to_string_lossy());
        std::fs::write(&stream, "secret").unwrap();
        assert!(read(&fixture, Path::new(&stream)).is_err(), "{stream}");
        // Device names are a device or nothing, never a file to show.
        for device in ["NUL", "CON", "aux.txt", "COM1"] {
            let path = fixture.root.join("elsewhere").join(device);
            assert!(read(&fixture, &path).is_err(), "{device}");
        }
        assert!(read(&fixture, Path::new(r"\\.\NUL")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_drive_is_the_same_drive() {
        assert!(within(
            Path::new(r"\\?\C:\Data\aux.c"),
            Path::new(r"c:\data")
        ));
        assert!(within(Path::new(r"C:\Data\x"), Path::new(r"\\?\C:\data")));
        assert!(!within(Path::new(r"D:\Data\x"), Path::new(r"C:\Data")));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_spelling_of_the_checkout_is_refused() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("checkout/a.txt"), "in").unwrap();
        let shouted = fixture
            .root
            .join("checkout/a.txt")
            .to_string_lossy()
            .to_uppercase()
            .replace('\\', "/");
        let error = target_of(&shouted, &fixture.fence).unwrap_err();
        assert!(error.to_string().contains("in this checkout"), "{error}");
        let file = fixture.root.join("elsewhere/b.txt");
        std::fs::write(&file, "out").unwrap();
        let forward = file.to_string_lossy().replace('\\', "/");
        let read = read_target(
            &target_of(&forward, &fixture.fence).unwrap(),
            &fixture.fence,
        )
        .unwrap();
        assert_eq!(read.content, "out");
    }
}
