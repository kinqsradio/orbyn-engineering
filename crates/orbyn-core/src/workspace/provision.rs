//! The library is part of the product, so nobody sets it up. First launch unpacks the
//! snapshot the app ships with, which needs no network and takes no time to speak of.
//! Later, when Git and a network are there, a real clone replaces it so updates can
//! arrive, and until that works the snapshot simply stays. Neither step touches a
//! target, and neither makes a run wait.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{CLONE_SYMLINKS, Workspace, WorkspaceState, upstream_of, validate_library};
use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git::{git, text};
use crate::util::{canonicalize, new_id};

/// The name a provisioned library has under the data folder.
const LIBRARY_DIR: &str = "workspace";
/// A folder being built. Whatever has this name at startup was interrupted.
const STAGING: &str = ".workspace-";
/// A library being replaced, until its `repo/` has moved across.
const REPLACED: &str = ".workspace-old-";
/// Something unusable found where the library goes. Kept for a person to look at.
const SET_ASIDE: &str = ".workspace-broken-";
/// The revision of a library made with no bundle, as in a bare `orbynd`.
pub(super) const UNBUNDLED: &str = "unbundled";
/// The revision of a library found with no record of where it came from.
const UNKNOWN: &str = "unknown";
const CLONE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const FIRST_ATTEMPT: Duration = Duration::from_secs(5);
const LONGEST_GAP: Duration = Duration::from_secs(6 * 60 * 60);
/// How often a finished clone looks for a moment with no run.
const IDLE_POLL: Duration = Duration::from_secs(30);
/// Far more than the library holds: this bounds a damaged bundle.
const MAX_BUNDLE_ENTRIES: usize = 200_000;

pub(super) fn idle_poll() -> Duration {
    IDLE_POLL
}

/// Removes a staging folder however its owner ends.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `<dir>/library.tar`, a `git archive` of the revision named in `<dir>/REVISION`.
fn read_bundle(dir: &Path) -> Option<(PathBuf, String)> {
    let archive = dir.join("library.tar");
    let revision = std::fs::read_to_string(dir.join("REVISION")).ok()?;
    let revision = revision.trim();
    (archive.is_file() && !revision.is_empty()).then(|| (archive, revision.to_owned()))
}

/// The path of an entry inside `into`, or `None` for one that would leave it.
fn inside(into: &Path, name: &Path) -> Option<PathBuf> {
    let plain = name
        .components()
        .all(|part| matches!(part, Component::Normal(_) | Component::CurDir));
    (plain && name.components().next().is_some()).then(|| into.join(name))
}

/// True when a link at `link` pointing to `target` stays inside `into`.
fn link_stays_inside(into: &Path, link: &Path, target: &Path) -> bool {
    let Some(mut place) = link.parent().map(Path::to_path_buf) else {
        return false;
    };
    for part in target.components() {
        match part {
            Component::CurDir => {}
            Component::Normal(name) => place.push(name),
            Component::ParentDir => {
                if !place.pop() {
                    return false;
                }
            }
            _ => return false,
        }
    }
    place.starts_with(into)
}

/// Makes a link, or where the OS will not allow one, what Git leaves in that case: a
/// text file holding the target. `native_skills_available` then reports the MCP route.
fn make_link(link: &Path, target: &Path) -> Result<()> {
    if create_link(link, target).is_err() {
        std::fs::write(link, target.to_string_lossy().replace('\\', "/"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_link(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_link(link: &Path, target: &Path) -> std::io::Result<()> {
    // Windows reads a link's target literally, and a tar stores it with `/`.
    let target = PathBuf::from(target.to_string_lossy().replace('/', "\\"));
    let resolved = link.parent().map(|parent| parent.join(&target));
    if resolved.is_some_and(|path| path.is_dir()) {
        std::os::windows::fs::symlink_dir(&target, link)
    } else {
        std::os::windows::fs::symlink_file(&target, link)
    }
}

#[cfg(unix)]
fn keep_executable(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if mode & 0o111 != 0 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn keep_executable(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

/// Unpacks into a fresh folder. Links wait for the files, so that Windows can tell a
/// folder link from a file link, and anything aimed outside refuses the whole bundle.
fn unpack(archive: &Path, into: &Path) -> Result<()> {
    let damaged = || CoreError::Internal("The bundled library is damaged.".into());
    let file = std::fs::File::open(archive)?;
    let mut reader = tar::Archive::new(file);
    let mut links = Vec::new();
    for (count, entry) in reader.entries()?.enumerate() {
        if count > MAX_BUNDLE_ENTRIES {
            return Err(damaged());
        }
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            continue;
        }
        let name = entry.path()?.into_owned();
        let path = inside(into, &name).ok_or_else(damaged)?;
        if kind.is_dir() {
            std::fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if kind.is_symlink() {
            let target = entry.link_name()?.ok_or_else(damaged)?.into_owned();
            if !link_stays_inside(into, &path, &target) {
                return Err(damaged());
            }
            links.push((path, target));
            continue;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        std::fs::write(&path, bytes)?;
        keep_executable(&path, entry.header().mode().unwrap_or(0))?;
    }
    for (link, target) in links {
        make_link(&link, &target)?;
    }
    if into.join("skills/catalog.json").is_file() && into.join("AGENTS.md").is_file() {
        Ok(())
    } else {
        Err(damaged())
    }
}

/// With no bundle there are no skills yet, but everything else still works, and the
/// clone brings them.
fn write_empty_library(into: &Path) -> Result<()> {
    std::fs::create_dir_all(into.join("skills"))?;
    std::fs::write(into.join("skills/catalog.json"), r#"{"skills":[]}"#)?;
    std::fs::write(into.join(".gitignore"), "/repo/\n")?;
    std::fs::write(
        into.join("AGENTS.md"),
        "# Orbyn skills library\n\nThe skills are still on their way.\n",
    )?;
    Ok(())
}

/// One local commit, so the snapshot is the Git root everything else expects: boundary
/// checks, ignored `repo/` and dirty state all come from Git. A machine with no Git
/// keeps a plain folder, and clones nothing either.
async fn commit_snapshot(into: &Path, revision: &str) {
    let steps: [&[&str]; 3] = [
        &[
            "-c",
            CLONE_SYMLINKS,
            "init",
            "--quiet",
            "--template=",
            "--initial-branch=main",
        ],
        &["add", "--all"],
        &[
            "-c",
            "user.name=Orbyn",
            "-c",
            "user.email=orbyn@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            revision,
        ],
    ];
    for step in steps {
        if let Err(error) = git(into, step).await {
            tracing::debug!("the library snapshot is not in Git: {error}");
            let _ = std::fs::remove_dir_all(into.join(".git"));
            return;
        }
    }
}

/// Finishes a replacement a crash left: back to the old library if the new one never
/// arrived, otherwise on with moving `repo/` across.
fn recover_replacement(data: &Path) -> Result<()> {
    let root = data.join(LIBRARY_DIR);
    for entry in std::fs::read_dir(data)?.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(REPLACED) {
            continue;
        }
        if root.exists() {
            settle_replaced(&root, &entry.path())?;
        } else {
            std::fs::rename(entry.path(), &root)?;
        }
    }
    Ok(())
}

/// Hands `repo/` to the new library, since projects live there, then drops the old
/// one. A `repo/` that cannot be handed over keeps the old folder, and with it the work.
fn settle_replaced(root: &Path, old: &Path) -> Result<()> {
    let repo = root.join("repo");
    let held = old.join("repo");
    if held.exists() {
        // Only an empty one: `remove_dir` refuses anything else.
        let _ = std::fs::remove_dir(&repo);
        if repo.exists() {
            return Ok(());
        }
        std::fs::rename(held, repo)?;
    }
    let _ = std::fs::remove_dir_all(old);
    Ok(())
}

fn clear_staging(data: &Path) -> Result<()> {
    for entry in std::fs::read_dir(data)?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let kept = name.starts_with(REPLACED) || name.starts_with(SET_ASIDE);
        if name.starts_with(STAGING) && !kept {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

impl Workspace {
    /// Makes sure there is a library before the service answers anything. A library
    /// already in place is left exactly as it is, and an adopted one is never looked
    /// at, even when it has gone missing: that folder is the person's.
    pub async fn provision(&self) -> Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        let data = canonicalize(&self.data_dir)?;
        recover_replacement(&data)?;
        clear_staging(&data)?;
        let root = data.join(LIBRARY_DIR);
        let mut url = self.default_url.clone();
        match self.current() {
            Some(state) if state.adopted => return Ok(()),
            Some(state) if state.root.exists() => return self.settle_state(state).await,
            // Saved, then a crash before the folder arrived, or a person removed it.
            Some(state) => url = state.url.unwrap_or(url),
            None if root.exists() => match validate_library(&root).await {
                Ok(real) => return self.keep_found_library(real).await,
                Err(error) => {
                    tracing::warn!("set aside an unusable library: {error}");
                    let aside = data.join(format!("{SET_ASIDE}{}", new_id()));
                    std::fs::rename(&root, aside)?;
                }
            },
            None => {}
        }
        self.install_snapshot(&data, &root, url).await
    }

    /// A crash can land between a replacement and saving it.
    async fn settle_state(&self, mut state: WorkspaceState) -> Result<()> {
        if state.snapshot.is_some() && upstream_of(&state.root).await.is_some() {
            state.snapshot = None;
            self.save(state)?;
        }
        Ok(())
    }

    async fn keep_found_library(&self, root: PathBuf) -> Result<()> {
        let tracked = upstream_of(&root).await.is_some();
        let origin = git(&root, &["remote", "get-url", "origin"]).await;
        self.save(WorkspaceState {
            root,
            adopted: false,
            url: Some(origin.map_or_else(|_| self.default_url.clone(), |url| text(&url))),
            rollback: None,
            snapshot: (!tracked).then(|| UNKNOWN.to_owned()),
        })
    }

    async fn install_snapshot(&self, data: &Path, root: &Path, url: String) -> Result<()> {
        let staging = Staging(data.join(format!("{STAGING}{}", new_id())));
        std::fs::create_dir_all(&staging.0)?;
        let bundle = self.bundle.as_deref().and_then(read_bundle);
        let revision = match bundle {
            Some((archive, revision)) => {
                unpack(&archive, &staging.0)?;
                revision
            }
            None => {
                write_empty_library(&staging.0)?;
                UNBUNDLED.to_owned()
            }
        };
        commit_snapshot(&staging.0, &revision).await;
        std::fs::create_dir_all(staging.0.join("repo"))?;
        // State first: a crash here reads as a library that went missing, and a
        // finished folder never exists with nothing saying what it is.
        self.save(WorkspaceState {
            root: root.to_path_buf(),
            adopted: false,
            url: Some(url),
            rollback: None,
            snapshot: Some(revision),
        })?;
        std::fs::rename(&staging.0, root)?;
        Ok(())
    }

    /// Refuses to replace anything a person changed. `repo/` crosses over, so it is the
    /// one thing allowed; anything else ignored would be lost with the old folder.
    async fn check_replaceable(&self, root: &Path) -> Result<()> {
        if !root.join(".git").exists() {
            return Ok(());
        }
        let status = git(root, &["status", "--porcelain", "--ignored"]).await?;
        let status = String::from_utf8_lossy(&status);
        if status.lines().any(|line| line != "!! repo/") {
            return Err(CoreError::LibraryDirty(
                "The library has local edits, so it stays as it is.".into(),
            ));
        }
        Ok(())
    }

    /// Replaces a snapshot with a clone of its URL. `Ok(false)` means there was nothing
    /// to do. Any failure leaves the snapshot in place; with `wait`, a finished clone
    /// waits for a moment with no run, and without it a run is `RunsActive`.
    pub async fn upgrade_snapshot(&self, wait: bool) -> Result<bool> {
        let _one_at_a_time = self.upgrading.lock().await;
        let Some(state) = self.current() else {
            return Ok(false);
        };
        if state.adopted || state.snapshot.is_none() {
            return Ok(false);
        }
        let url = state
            .url
            .clone()
            .unwrap_or_else(|| self.default_url.clone());
        if url.starts_with('-') {
            return Err(CoreError::Invalid("That URL is not valid.".into()));
        }
        self.check_replaceable(&state.root).await?;
        let data = canonicalize(&self.data_dir)?;
        let staging = Staging(data.join(format!("{STAGING}{}", new_id())));
        let target = staging.0.to_string_lossy().into_owned();
        let args = [
            "-c",
            CLONE_SYMLINKS,
            "clone",
            "--quiet",
            "--",
            &url,
            &target,
        ];
        match tokio::time::timeout(CLONE_TIMEOUT, git(&data, &args)).await {
            Ok(cloned) => cloned?,
            Err(_) => return Err(CoreError::Git("The clone took too long.".into())),
        };
        validate_library(&staging.0).await?;
        loop {
            #[cfg(test)]
            self.replacement_ready.notify_one();
            let writer = self.library_access.write().await;
            self.check_replaceable(&state.root).await?;
            let replaced = self.replace_library(&state, &staging.0);
            drop(writer);
            match replaced {
                Err(CoreError::RunsActive) if wait => tokio::time::sleep(self.idle_poll).await,
                other => return other.map(|()| true),
            }
        }
    }

    /// The swap itself. It holds the admission lock for a few renames with nothing
    /// awaited, so a run arriving now waits that long and then sees the new library.
    fn replace_library(&self, state: &WorkspaceState, staging: &Path) -> Result<()> {
        let moving = self.moving_lock();
        if *moving || !self.store.active_runs()?.is_empty() {
            return Err(CoreError::RunsActive);
        }
        let root = &state.root;
        let old = root.with_file_name(format!("{REPLACED}{}", new_id()));
        std::fs::rename(root, &old)?;
        if let Err(error) = std::fs::rename(staging, root) {
            let _ = std::fs::rename(&old, root);
            return Err(error.into());
        }
        settle_replaced(root, &old)?;
        std::fs::create_dir_all(root.join("repo"))?;
        let mut next = state.clone();
        next.snapshot = None;
        self.save(next)?;
        drop(moving);
        self.audit(
            "workspace.cloned",
            &root.to_string_lossy(),
            json!({ "url": state.url, "replaced": state.snapshot }),
        )
    }

    /// Asks for an attempt now, as a person checking for updates does.
    pub(super) fn wake_upgrade(&self) {
        self.upgrade_wake.notify_one();
    }

    /// What provisioning left beside the library.
    #[cfg(test)]
    pub(super) fn leftovers(data: &Path) -> std::collections::HashSet<String> {
        std::fs::read_dir(data)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(STAGING))
            .collect()
    }
}

impl Core {
    /// Keeps trying for a real clone, quietly, with growing gaps, for as long as there
    /// is a snapshot. It stays off the network when told to, unless a person asks.
    pub async fn run_library_upgrades(&self, stop: CancellationToken) {
        if !self.config.engines.lookup_latest {
            return;
        }
        let mut gap = FIRST_ATTEMPT;
        loop {
            let asked = tokio::select! {
                () = stop.cancelled() => return,
                () = tokio::time::sleep(gap) => false,
                () = self.workspace.upgrade_wake.notified() => true,
            };
            if self.workspace.root().is_err()
                && let Err(error) = self.workspace.provision().await
            {
                tracing::warn!("the library is not in place yet: {error}");
            }
            let allowed = self
                .store
                .settings()
                .is_ok_and(|settings| settings.background_update_checks != Some(false));
            if !(asked || allowed) {
                continue;
            }
            let attempt = tokio::select! {
                () = stop.cancelled() => return,
                attempt = self.workspace.upgrade_snapshot(true) => attempt,
            };
            match attempt {
                Ok(_) => return,
                Err(error) => tracing::debug!("the library stays a snapshot for now: {error}"),
            }
            gap = (gap * 2).min(LONGEST_GAP);
        }
    }
}

#[cfg(test)]
pub(super) fn tar_for_tests(path: &Path, entries: &[(&str, Option<&str>, &str)]) {
    let file = std::fs::File::create(path).unwrap();
    let mut archive = tar::Builder::new(file);
    for (name, link, body) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        match link {
            Some(target) => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
                header.set_link_name(target).unwrap();
                header.set_cksum();
                archive.append(&header, std::io::empty()).unwrap();
            }
            None => {
                header.set_size(body.len() as u64);
                header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
                header.set_cksum();
                archive.append(&header, body.as_bytes()).unwrap();
            }
        }
    }
    archive.finish().unwrap();
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use orbyn_contracts::WorkspaceSetup;

    use super::*;
    use crate::store::Store;
    use crate::testing::{TempDir, library, run_git};

    fn workspace(dir: &TempDir, url: &str, bundle: Option<PathBuf>) -> Workspace {
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = Arc::new(Store::open(&data.join("db"), "e").unwrap());
        Workspace::new(store, data, url.to_owned(), bundle).unwrap()
    }

    /// A bundle with a skill, reached through a link as the real library does.
    fn bundle(dir: &TempDir) -> PathBuf {
        let path = dir.path().join("bundle");
        std::fs::create_dir_all(&path).unwrap();
        tar_for_tests(
            &path.join("library.tar"),
            &[
                ("AGENTS.md", None, "# Library\n"),
                ("LICENSE", None, "MIT\n"),
                (".gitignore", None, "/repo/\n"),
                ("skills/catalog.json", None, r#"{"skills":[]}"#),
                ("skills/one/SKILL.md", None, "---\nname: one\n---\n"),
                (".claude/skills/one", Some("../../skills/one"), ""),
            ],
        );
        std::fs::write(path.join("REVISION"), "abc123\n").unwrap();
        path
    }

    fn offline_url(dir: &TempDir) -> String {
        dir.path()
            .join("no-such-upstream")
            .to_string_lossy()
            .into_owned()
    }

    #[tokio::test]
    async fn first_launch_offline_is_a_working_library_at_once() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        let root = workspace.root().unwrap();
        assert!(root.ends_with("workspace"));
        assert!(root.join("LICENSE").is_file(), "the notice ships with it");
        // The link works, or is the text file Git would leave on Windows.
        let link = root.join(".claude/skills/one");
        assert!(link.join("SKILL.md").is_file() || link.is_file());
        validate_library(&root).await.unwrap();
        let status = workspace.status(&[]).await.unwrap();
        assert!(status.configured);
        let library = status.library.unwrap();
        assert!(library.snapshot);
        assert!(!library.dirty, "{:?}", library.dirty_files);
        assert_eq!(library.revision, "abc123");
        assert_eq!(workspace.identity().await.unwrap().0, "abc123");
        assert!(Workspace::leftovers(root.parent().unwrap()).is_empty());
    }

    #[tokio::test]
    async fn with_no_bundle_there_is_still_a_library() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let workspace = workspace(&dir, &url, None);
        workspace.provision().await.unwrap();
        validate_library(&workspace.root().unwrap()).await.unwrap();
        assert_eq!(workspace.identity().await.unwrap().0, UNBUNDLED);
    }

    #[tokio::test]
    async fn a_second_launch_changes_nothing() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let first = workspace(&dir, &url, Some(bundle(&dir)));
        first.provision().await.unwrap();
        let root = first.root().unwrap();
        std::fs::write(root.join("repo/kept"), "x").unwrap();
        drop(first);
        let second = workspace(&dir, &url, Some(bundle(&dir)));
        second.provision().await.unwrap();
        assert!(root.join("repo/kept").is_file());
    }

    #[tokio::test]
    async fn an_interrupted_unpack_is_cleared_and_redone() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        let data = dir.path().join("data");
        std::fs::create_dir_all(data.join(".workspace-torn/skills")).unwrap();
        workspace.provision().await.unwrap();
        assert!(Workspace::leftovers(&data).is_empty());
        validate_library(&workspace.root().unwrap()).await.unwrap();
    }

    #[tokio::test]
    async fn a_crash_after_saving_but_before_the_folder_arrived_provisions_again() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let first = workspace(&dir, &url, Some(bundle(&dir)));
        first.provision().await.unwrap();
        let root = first.root().unwrap();
        drop(first);
        std::fs::remove_dir_all(&root).unwrap();
        let second = workspace(&dir, &url, Some(bundle(&dir)));
        second.provision().await.unwrap();
        validate_library(&root).await.unwrap();
    }

    #[tokio::test]
    async fn a_torn_replacement_goes_back_or_finishes_and_keeps_projects() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let first = workspace(&dir, &url, Some(bundle(&dir)));
        first.provision().await.unwrap();
        let root = first.root().unwrap();
        std::fs::create_dir_all(root.join("repo/app")).unwrap();
        drop(first);
        let data = root.parent().unwrap().to_path_buf();
        // Stopped before the new library moved in.
        let old = data.join(".workspace-old-a");
        std::fs::rename(&root, &old).unwrap();
        let second = workspace(&dir, &url, Some(bundle(&dir)));
        second.provision().await.unwrap();
        assert!(root.join("repo/app").is_dir());
        assert!(!old.exists());
        // Stopped with the new library in place and `repo/` still in the old one.
        let old = data.join(".workspace-old-b");
        std::fs::rename(&root, &old).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("new"), "x").unwrap();
        let third = workspace(&dir, &url, Some(bundle(&dir)));
        third.provision().await.unwrap();
        assert!(root.join("repo/app").is_dir());
        assert!(root.join("new").is_file());
        assert!(!old.exists());
    }

    #[tokio::test]
    async fn a_failed_clone_leaves_the_snapshot_and_leaves_nothing_else() {
        let dir = TempDir::new();
        let url = offline_url(&dir);
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        let root = workspace.root().unwrap();
        assert!(workspace.upgrade_snapshot(true).await.is_err());
        validate_library(&root).await.unwrap();
        assert!(
            workspace
                .status(&[])
                .await
                .unwrap()
                .library
                .unwrap()
                .snapshot
        );
        assert!(Workspace::leftovers(root.parent().unwrap()).is_empty());
    }

    #[tokio::test]
    async fn replacement_waits_for_a_library_reader_and_its_git_child() {
        use std::future::{Future, poll_fn};
        use std::process::Stdio;
        use std::task::Poll;

        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let workspace = workspace(&dir, &upstream.to_string_lossy(), None);
        workspace.provision().await.unwrap();
        let root = workspace.root().unwrap();

        // Use the same guard as public readers, with a real Git process whose cwd
        // stays in the old library until its pipe closes. No global Git overrides.
        let reader = workspace.library_access.read().await;
        let mut child = tokio::process::Command::new("git")
            .args(["cat-file", "--batch-check"])
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"HEAD\n")
            .await
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), output.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert!(line.contains(" commit "), "{line}");
        assert!(child.try_wait().unwrap().is_none());

        let mut upgrade = std::pin::pin!(workspace.upgrade_snapshot(false));
        tokio::select! {
            () = workspace.replacement_ready.notified() => {},
            result = &mut upgrade => panic!("replacement passed the live reader: {result:?}"),
            () = tokio::time::sleep(Duration::from_secs(10)) => panic!("clone never reached replacement"),
        }
        poll_fn(|cx| match upgrade.as_mut().poll(cx) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(result) => panic!("replacement passed the live reader: {result:?}"),
        })
        .await;
        assert!(
            workspace.library_access.try_read().is_err(),
            "replacement must queue behind the live library reader"
        );
        assert_eq!(
            workspace.current().unwrap().snapshot.as_deref(),
            Some(UNBUNDLED)
        );

        drop(child.stdin.take());
        assert!(
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        drop(reader);
        assert!(
            tokio::time::timeout(Duration::from_secs(10), upgrade)
                .await
                .unwrap()
                .unwrap()
        );
        let library = workspace.status(&[]).await.unwrap().library.unwrap();
        assert!(!library.snapshot);
        assert_eq!(library.upstream.as_deref(), Some("origin/main"));
    }

    #[tokio::test]
    async fn public_library_readers_wait_for_replacement() {
        use std::future::{Future, poll_fn};
        use std::task::Poll;

        async fn waits<F: Future>(workspace: &Workspace, reader: F) {
            let writer = workspace.library_access.write().await;
            let mut reader = std::pin::pin!(reader);
            poll_fn(|cx| match reader.as_mut().poll(cx) {
                Poll::Pending => Poll::Ready(()),
                Poll::Ready(_) => panic!("library reader passed the replacement guard"),
            })
            .await;
            // Queue a second writer after the reader. Once the first writer lets
            // go, the reader must get its reservation before this writer can.
            // A reader accidentally waiting on Git instead of the lock fails here.
            let mut next_writer = std::pin::pin!(workspace.library_access.write());
            poll_fn(|cx| match next_writer.as_mut().poll(cx) {
                Poll::Pending => Poll::Ready(()),
                Poll::Ready(_) => panic!("first writer did not retain its guard"),
            })
            .await;
            drop(writer);
            poll_fn(|cx| match next_writer.as_mut().poll(cx) {
                Poll::Pending => Poll::Ready(()),
                Poll::Ready(_) => panic!("library reader did not reserve the read guard"),
            })
            .await;
            let _ = tokio::time::timeout(Duration::from_secs(5), reader)
                .await
                .unwrap();
            drop(next_writer.await);
        }

        let dir = TempDir::new();
        let workspace = workspace(&dir, &offline_url(&dir), None);
        workspace.provision().await.unwrap();
        waits(&workspace, workspace.status(&[])).await;
        waits(&workspace, workspace.identity()).await;
        waits(&workspace, workspace.upstream_revision()).await;
        waits(&workspace, workspace.fetch()).await;
        waits(&workspace, workspace.local_position()).await;
        waits(&workspace, workspace.update(true)).await;
        waits(&workspace, workspace.rollback()).await;
    }

    #[tokio::test]
    async fn a_clone_replaces_the_snapshot_and_keeps_every_project() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = upstream.to_string_lossy().into_owned();
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        let root = workspace.root().unwrap();
        std::fs::create_dir_all(root.join("repo/app")).unwrap();
        std::fs::write(root.join("repo/app/file"), "mine").unwrap();
        assert!(workspace.upgrade_snapshot(true).await.unwrap());
        assert_eq!(workspace.root().unwrap(), root);
        assert_eq!(std::fs::read(root.join("repo/app/file")).unwrap(), b"mine");
        let library = workspace.status(&[]).await.unwrap().library.unwrap();
        assert!(!library.snapshot);
        assert!(library.upstream.is_some(), "updates can arrive now");
        assert!(Workspace::leftovers(root.parent().unwrap()).is_empty());
        assert!(!workspace.upgrade_snapshot(true).await.unwrap());
    }

    #[tokio::test]
    async fn local_edits_keep_the_snapshot() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = upstream.to_string_lossy().into_owned();
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        let root = workspace.root().unwrap();
        std::fs::write(root.join("AGENTS.md"), "my own").unwrap();
        assert!(matches!(
            workspace.upgrade_snapshot(true).await,
            Err(CoreError::LibraryDirty(_))
        ));
        assert_eq!(std::fs::read(root.join("AGENTS.md")).unwrap(), b"my own");
    }

    #[tokio::test]
    async fn an_ignored_file_beside_repo_keeps_the_snapshot() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = upstream.to_string_lossy().into_owned();
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        let root = workspace.root().unwrap();
        std::fs::write(root.join(".gitignore"), "/repo/\n/notes\n").unwrap();
        run_git(&root, &["add", "."]);
        run_git(
            &root,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "x",
            ],
        );
        std::fs::write(root.join("notes"), "mine").unwrap();
        assert!(workspace.upgrade_snapshot(true).await.is_err());
        assert!(root.join("notes").is_file());
    }

    #[tokio::test]
    async fn an_active_run_is_refused_only_to_a_caller_who_will_not_wait() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = upstream.to_string_lossy().into_owned();
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        *workspace.moving_lock() = true;
        assert!(matches!(
            workspace.upgrade_snapshot(false).await,
            Err(CoreError::RunsActive)
        ));
        *workspace.moving_lock() = false;
        assert!(
            workspace
                .status(&[])
                .await
                .unwrap()
                .library
                .unwrap()
                .snapshot
        );
    }

    #[tokio::test]
    async fn an_adopted_library_survives_an_upgrade_untouched() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = offline_url(&dir);
        let first = workspace(&dir, &url, None);
        // The state an earlier version saved, with no `snapshot` key.
        let root = canonicalize(&upstream).unwrap();
        first
            .store
            .set_setting(
                super::super::STATE_KEY,
                &serde_json::to_string(&json!({
                    "root": root, "adopted": true, "url": null, "rollback": null,
                }))
                .unwrap(),
            )
            .unwrap();
        drop(first);
        let second = workspace(&dir, &url, Some(bundle(&dir)));
        second.provision().await.unwrap();
        assert_eq!(second.root().unwrap(), root);
        assert!(!dir.path().join("data/workspace").exists());
        assert!(!second.upgrade_snapshot(true).await.unwrap());
        let library = second.status(&[]).await.unwrap().library.unwrap();
        assert!(library.adopted && !library.snapshot);
    }

    #[tokio::test]
    async fn an_old_clone_with_a_saved_state_stays_a_clone() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = upstream.to_string_lossy().into_owned();
        let first = workspace(&dir, &url, None);
        first
            .setup(WorkspaceSetup {
                url: None,
                adopt_path: None,
            })
            .await
            .unwrap();
        let root = first.root().unwrap();
        drop(first);
        let second = workspace(&dir, &url, Some(bundle(&dir)));
        second.provision().await.unwrap();
        let library = second.status(&[]).await.unwrap().library.unwrap();
        assert!(!library.snapshot);
        assert_eq!(second.root().unwrap(), root);
    }

    #[tokio::test]
    async fn an_update_is_still_refused_while_the_clone_is_dirty() {
        let dir = TempDir::new();
        let upstream = library(&dir.path().join("upstream"));
        let url = upstream.to_string_lossy().into_owned();
        let workspace = workspace(&dir, &url, Some(bundle(&dir)));
        workspace.provision().await.unwrap();
        workspace.upgrade_snapshot(true).await.unwrap();
        std::fs::write(upstream.join("new"), "x").unwrap();
        run_git(&upstream, &["add", "."]);
        run_git(&upstream, &["commit", "-q", "-m", "new"]);
        let root = workspace.root().unwrap();
        std::fs::write(root.join("AGENTS.md"), "edited").unwrap();
        assert!(matches!(
            workspace.update(true).await,
            Err(CoreError::LibraryDirty(_))
        ));
    }

    #[test]
    fn an_entry_or_link_leaving_the_library_refuses_the_bundle() {
        let dir = TempDir::new();
        for entries in [
            vec![("../out", None, "x")],
            vec![("a/link", Some("../../out"), "")],
            vec![("/abs", None, "x")],
        ] {
            let archive = dir.path().join("bad.tar");
            tar_for_tests(&archive, &entries);
            let into = dir.path().join("into");
            std::fs::create_dir_all(&into).unwrap();
            assert!(unpack(&archive, &into).is_err(), "{entries:?}");
            std::fs::remove_dir_all(&into).unwrap();
        }
        assert!(!dir.path().join("out").exists());
    }

    #[test]
    fn a_bundle_with_no_library_in_it_is_refused() {
        let dir = TempDir::new();
        let archive = dir.path().join("empty.tar");
        tar_for_tests(&archive, &[("README", None, "x")]);
        let into = dir.path().join("into");
        std::fs::create_dir_all(&into).unwrap();
        assert!(unpack(&archive, &into).is_err());
    }

    #[test]
    fn a_link_stays_inside_only_when_its_target_does() {
        let into = Path::new("/lib");
        let link = Path::new("/lib/.claude/skills/one");
        assert!(link_stays_inside(into, link, Path::new("../../skills/one")));
        assert!(!link_stays_inside(into, link, Path::new("../../../etc")));
        assert!(!link_stays_inside(into, link, Path::new("/etc")));
    }
}
