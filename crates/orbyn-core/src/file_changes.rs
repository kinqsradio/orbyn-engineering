//! What a run changed, kept as bytes. Only files a tool named count, and nothing is
//! inferred from the folder, so a thread sharing it adds nothing here. A file's new
//! bytes are read when the tool ends, which freezes them against whatever happens to it
//! afterwards. Its old bytes come from the moment the gate allows the write, or the
//! `orbyn_track_files` handshake for writes no tool reports, or failing those the run's
//! start checkpoint. An engine's "started" notice is not used: it arrives after a fast
//! write, and would make a change look like no change. With none of those, that end is
//! unknown, and says so.

use std::path::{Path, PathBuf};

use orbyn_contracts::{
    ChangedFileContent, RestoreChanges, RestoreOutcome, RestorePoint, RestoredFile,
};
use serde_json::json;

use crate::app::Core;
use crate::approvals::{RunScope, WriteScope};
use crate::error::{CoreError, Result};
use crate::files::{inside, open_inside};
use crate::git::{git, text};
use crate::store::{AuditRecord, KeptChange, Snapshot, Store};
use crate::util::new_id;

const MAX_FILES: i64 = 200;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_RUN_BYTES: i64 = 32 * 1024 * 1024;
/// Across all runs. Past this the oldest bytes go and their paths stay.
const MAX_TOTAL_BYTES: i64 = 512 * 1024 * 1024;

/// `path` as the engine meant it, relative to the checkout, or `None` outside it.
fn relative_in(scope: &WriteScope, path: &str) -> Option<String> {
    let checkout = crate::util::canonicalize(&scope.checkout).ok()?;
    let real = scope.resolved(path)?;
    let relative = real.strip_prefix(&checkout).ok()?;
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn checkout_scope(scope: &WriteScope) -> WriteScope {
    WriteScope {
        engine_cwd: scope.checkout.clone(),
        ..scope.clone()
    }
}

/// A look at a file, through the same checks as any other read of the checkout.
fn look(scope: &WriteScope, relative: &str) -> Snapshot {
    let Ok(full) = inside(scope, relative) else {
        return Snapshot::Unknown;
    };
    match std::fs::symlink_metadata(&full) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Snapshot::Absent,
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => {}
        _ => return Snapshot::Unknown,
    }
    let Ok((mut file, _)) = open_inside(scope, relative, &full) else {
        return Snapshot::Unknown;
    };
    let mut bytes = Vec::new();
    match std::io::Read::read_to_end(&mut file, &mut bytes) {
        Ok(_) => Snapshot::Stored(bytes),
        Err(_) => Snapshot::Unknown,
    }
}

/// Keeps a look at each file. A failure here costs that record, never the run.
pub(crate) fn record(store: &Store, scope: &RunScope, paths: &[String], done: bool) {
    let Some(write_scope) = &scope.write_scope else {
        return;
    };
    let reader = checkout_scope(write_scope);
    for path in paths {
        let Some(relative) = relative_in(write_scope, path) else {
            continue;
        };
        let snapshot = look(&reader, &relative);
        let limits = (MAX_FILES, MAX_RUN_BYTES);
        if let Err(error) = store.record_change(&scope.run_id, &relative, snapshot, done, limits) {
            tracing::debug!(%error, "could not keep a changed file");
        }
    }
    if done && let Err(error) = store.prune_changes(MAX_TOTAL_BYTES) {
        tracing::debug!(%error, "could not prune kept changes");
    }
}

/// A file as the run's start checkpoint held it.
async fn at_checkpoint(checkout: &Path, sha: &str, relative: &str) -> Snapshot {
    let spec = format!("{sha}:{relative}");
    let Ok(size) = git(checkout, &["cat-file", "-s", &spec]).await else {
        return Snapshot::Absent;
    };
    let fits = text(&size)
        .parse::<u64>()
        .is_ok_and(|size| size <= MAX_FILE_BYTES);
    if !fits {
        return Snapshot::Unknown;
    }
    git(checkout, &["cat-file", "blob", &spec])
        .await
        .map_or(Snapshot::Unknown, Snapshot::Stored)
}

/// Records what a finished tool left, and fills in what it found from the run's
/// checkpoint where nothing caught the file before the write.
pub(crate) async fn finished(store: &Store, scope: &RunScope, paths: &[String]) {
    record(store, scope, paths, true);
    let Some(write_scope) = &scope.write_scope else {
        return;
    };
    let Ok(Some(checkpoint)) = store.checkpoint(&scope.run_id) else {
        return;
    };
    for path in paths {
        let Some(relative) = relative_in(write_scope, path) else {
            continue;
        };
        let missing = store
            .kept_change(&scope.run_id, &relative)
            .ok()
            .flatten()
            .is_some_and(|change| change.before == Snapshot::Unknown);
        if !missing {
            continue;
        }
        let found = at_checkpoint(&write_scope.checkout, &checkpoint.start, &relative).await;
        if let Err(error) = store.fill_change_start(&scope.run_id, &relative, &found, MAX_RUN_BYTES)
        {
            tracing::debug!(%error, "could not keep a file's start");
        }
    }
}

fn file_scope_of(checkout: &Path, root: &Path) -> WriteScope {
    WriteScope {
        checkout: checkout.to_path_buf(),
        engine_cwd: checkout.to_path_buf(),
        excluded: if checkout == root {
            vec![root.join("repo")]
        } else {
            Vec::new()
        },
    }
}

/// Writes `bytes` by rename, or removes the file for an absent end.
fn put(full: &Path, target: &Snapshot) -> Result<()> {
    let Snapshot::Stored(bytes) = target else {
        return std::fs::remove_file(full).map_err(Into::into);
    };
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial: PathBuf = full.with_file_name(format!(".orbyn-restore-{}", new_id()));
    std::fs::write(&partial, bytes)?;
    if let Ok(meta) = std::fs::metadata(full) {
        std::fs::set_permissions(&partial, meta.permissions())?;
    }
    if let Err(error) = std::fs::rename(&partial, full) {
        let _ = std::fs::remove_file(&partial);
        return Err(error.into());
    }
    Ok(())
}

fn restore_one(
    scope: &WriteScope,
    change: &KeptChange,
    point: RestorePoint,
) -> Result<RestoreOutcome> {
    let (target, other) = match point {
        RestorePoint::Start => (&change.before, &change.after),
        RestorePoint::End => (&change.after, &change.before),
    };
    if *target == Snapshot::Unknown {
        return Ok(RestoreOutcome::NotKept);
    }
    let full = inside(scope, &change.path)?;
    let current = look(scope, &change.path);
    if current == *target {
        return Ok(RestoreOutcome::Unchanged);
    }
    if current != *other {
        return Ok(RestoreOutcome::Conflict);
    }
    put(&full, target)?;
    Ok(RestoreOutcome::Restored)
}

impl Core {
    fn run_in_thread(&self, thread_id: &str, run_id: &str) -> Result<()> {
        if self.store.run(run_id)?.thread_id != thread_id {
            return Err(CoreError::NotFound("run".into()));
        }
        Ok(())
    }

    /// A file as a run found and left it. Reads only what was kept.
    pub fn changed_file(
        &self,
        thread_id: &str,
        run_id: &str,
        path: &str,
    ) -> Result<ChangedFileContent> {
        self.run_in_thread(thread_id, run_id)?;
        let change = self
            .store
            .kept_change(run_id, path)?
            .ok_or_else(|| CoreError::NotFound("change".into()))?;
        let text = |snapshot: &Snapshot| match snapshot {
            Snapshot::Stored(bytes) => std::str::from_utf8(bytes).ok().map(str::to_owned),
            _ => None,
        };
        let stored = |s: &Snapshot| matches!(s, Snapshot::Stored(_));
        let (before, after) = (text(&change.before), text(&change.after));
        let binary = (stored(&change.before) && before.is_none())
            || (stored(&change.after) && after.is_none());
        Ok(ChangedFileContent {
            status: change.status(),
            path: change.path,
            before,
            after,
            binary,
        })
    }

    /// Puts files back to one end of a run, from what was kept, so this works where a
    /// checkpoint cannot: in a folder other threads share, outside Git, and on one file.
    /// A file holding anything but the run's own bytes is someone's later work, so it
    /// is reported and left alone.
    pub fn restore_changes(
        &self,
        thread_id: &str,
        run_id: &str,
        request: &RestoreChanges,
        actor: &str,
    ) -> Result<Vec<RestoredFile>> {
        self.run_in_thread(thread_id, run_id)?;
        let thread = self.idle_thread(thread_id)?;
        let root = self.workspace.root()?;
        let scope = file_scope_of(Path::new(&thread.cwd), &root);
        let mut changes = self.store.kept_changes(run_id)?;
        if let Some(wanted) = &request.paths {
            if let Some(unknown) = wanted
                .iter()
                .find(|path| !changes.iter().any(|change| change.path == **path))
            {
                return Err(CoreError::Invalid(format!(
                    "This run has no change to {unknown}."
                )));
            }
            changes.retain(|change| wanted.contains(&change.path));
        }
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "run.restore_changes".into(),
            target: run_id.to_owned(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: Some(run_id.to_owned()),
            detail: json!({ "point": request.point, "files": changes.len() }),
        })?;
        changes
            .iter()
            .map(|change| {
                Ok(RestoredFile {
                    path: change.path.clone(),
                    outcome: restore_one(&scope, change, request.point)?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn scope(dir: &Path) -> WriteScope {
        let real = crate::util::canonicalize(dir).unwrap();
        WriteScope {
            checkout: real.clone(),
            engine_cwd: real,
            excluded: Vec::new(),
        }
    }

    #[test]
    fn a_look_keeps_small_files_and_refuses_the_rest() {
        let dir = TempDir::new();
        let scope = scope(dir.path());
        std::fs::write(dir.path().join("a"), "one").unwrap();
        assert_eq!(look(&scope, "a"), Snapshot::Stored(b"one".to_vec()));
        assert_eq!(look(&scope, "missing"), Snapshot::Absent);
        let large = std::fs::File::create(dir.path().join("big")).unwrap();
        large.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(look(&scope, "big"), Snapshot::Unknown);
        assert_eq!(look(&scope, "../escape"), Snapshot::Unknown);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_is_never_read_and_never_put_back_through() {
        let dir = TempDir::new();
        let outside = TempDir::new();
        let scope = scope(dir.path());
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("l")).unwrap();
        assert_eq!(look(&scope, "l"), Snapshot::Unknown);
        let change = KeptChange {
            path: "l".into(),
            before: Snapshot::Stored(b"x".to_vec()),
            after: Snapshot::Stored(b"s".to_vec()),
        };
        assert!(restore_one(&scope, &change, RestorePoint::Start).is_err());
        assert_eq!(std::fs::read(outside.path().join("secret")).unwrap(), b"s");
    }

    #[test]
    fn a_restore_leaves_later_work_alone() {
        let dir = TempDir::new();
        let scope = scope(dir.path());
        let change = KeptChange {
            path: "a".into(),
            before: Snapshot::Stored(b"old".to_vec()),
            after: Snapshot::Stored(b"new".to_vec()),
        };
        std::fs::write(dir.path().join("a"), "mine").unwrap();
        let outcome = restore_one(&scope, &change, RestorePoint::Start).unwrap();
        assert_eq!(outcome, RestoreOutcome::Conflict);
        assert_eq!(std::fs::read(dir.path().join("a")).unwrap(), b"mine");

        std::fs::write(dir.path().join("a"), "new").unwrap();
        let outcome = restore_one(&scope, &change, RestorePoint::Start).unwrap();
        assert_eq!(outcome, RestoreOutcome::Restored);
        assert_eq!(std::fs::read(dir.path().join("a")).unwrap(), b"old");
        let outcome = restore_one(&scope, &change, RestorePoint::Start).unwrap();
        assert_eq!(outcome, RestoreOutcome::Unchanged);
        let outcome = restore_one(&scope, &change, RestorePoint::End).unwrap();
        assert_eq!(outcome, RestoreOutcome::Restored);
    }

    #[test]
    fn an_added_file_goes_and_an_unkept_end_does_nothing() {
        let dir = TempDir::new();
        let scope = scope(dir.path());
        std::fs::write(dir.path().join("a"), "new").unwrap();
        let added = KeptChange {
            path: "a".into(),
            before: Snapshot::Absent,
            after: Snapshot::Stored(b"new".to_vec()),
        };
        assert_eq!(
            restore_one(&scope, &added, RestorePoint::Start).unwrap(),
            RestoreOutcome::Restored
        );
        assert!(!dir.path().join("a").exists());
        let unknown = KeptChange {
            path: "b".into(),
            before: Snapshot::Unknown,
            after: Snapshot::Stored(b"x".to_vec()),
        };
        assert_eq!(
            restore_one(&scope, &unknown, RestorePoint::Start).unwrap(),
            RestoreOutcome::NotKept
        );
    }
}
