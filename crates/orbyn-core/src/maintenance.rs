//! Diagnostics, database repair, the telemetry endpoint check, automatic pull and
//! storage cleanup. Cleanup removes a worktree only through `git worktree remove`
//! with no force, so Git itself keeps anything uncommitted, and it never touches a
//! worktree a live thread uses or a folder Orbyn did not make.

use std::path::Path;
use std::time::{Duration, SystemTime};

use orbyn_contracts::{CleanupEntry, CleanupReport, DatabaseStorage, Diagnostics, OtlpResult};
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git::{git, text};
use crate::store::AuditRecord;
use crate::util::{now, parse_time, unix_now};

const REPAIR_THRESHOLD: u64 = 1024 * 1024 * 1024;
const OTLP_TIMEOUT: Duration = Duration::from_secs(5);
const REPORT_SETTING: &str = "storage_cleanup_report";
const DAY: i64 = 24 * 60 * 60;

fn days(rules: &Value, key: &str) -> Option<i64> {
    rules.get(key).and_then(Value::as_i64)
}

/// Removes files older than `age` days directly inside `folder`.
fn sweep(folder: &Path, kind: &str, age: i64, dry_run: bool, entries: &mut Vec<CleanupEntry>) {
    let Ok(items) = std::fs::read_dir(folder) else {
        return;
    };
    let limit = Duration::from_secs(u64::try_from(age * DAY).unwrap_or(0));
    for item in items.flatten() {
        let old = item
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|elapsed| elapsed >= limit);
        if old && item.file_type().is_ok_and(|kind| kind.is_file()) {
            let removed = !dry_run && std::fs::remove_file(item.path()).is_ok();
            entries.push(CleanupEntry {
                kind: kind.to_owned(),
                path: item.path().to_string_lossy().into_owned(),
                removed,
                reason: format!("Older than {age} days"),
            });
        }
    }
}

impl Core {
    pub fn diagnostics(&self) -> Result<Diagnostics> {
        let (bytes, reclaimable_bytes) = self.store.database_storage()?;
        Ok(Diagnostics {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
            active_runs: self.runs.active_count(),
            terminals: self.terminals.count(),
            database: DatabaseStorage {
                bytes,
                reclaimable_bytes,
                repair_suggested: reclaimable_bytes >= REPAIR_THRESHOLD,
            },
            processes: crate::diagnostics::service_processes(),
            history: crate::diagnostics::resource_history(),
            events: crate::diagnostics::recent_events(),
        })
    }

    /// Rewrites the database, which needs it to be quiet.
    pub fn repair_database(&self) -> Result<()> {
        if self.runs.active_count() > 0 {
            return Err(CoreError::RunsActive);
        }
        self.store.repair_database()
    }

    /// Sends an empty export. Any HTTP answer proves the URL is reachable, and a
    /// status outside 2xx is reported as what it is.
    pub async fn check_otlp(&self, url: &str) -> OtlpResult {
        let failed = |message: String| OtlpResult {
            ok: false,
            status: None,
            message: Some(message),
        };
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return failed("Use an http or https URL.".to_owned());
        }
        let client = reqwest::Client::new();
        match client
            .post(url)
            .header("content-type", "application/json")
            .body("{}")
            .timeout(OTLP_TIMEOUT)
            .send()
            .await
        {
            Ok(response) => OtlpResult {
                ok: response.status().is_success(),
                status: Some(response.status().as_u16()),
                message: None,
            },
            Err(error) => failed(error.without_url().to_string()),
        }
    }

    /// Fast-forwards a clean default branch. Anything else is left alone.
    pub async fn pull_project(&self, project_id: &str, actor: &str) -> Result<()> {
        let project = self.store.project(project_id)?;
        if !project.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let cwd = Path::new(&project.path);
        if !text(&git(cwd, &["status", "--porcelain"]).await?).is_empty() {
            return Err(CoreError::Invalid(
                "This checkout has local changes.".into(),
            ));
        }
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "git.pull".into(),
            target: project.path.clone(),
            decision: None,
            source: "user".into(),
            thread_id: None,
            run_id: None,
            detail: Value::Null,
        })?;
        crate::scm::git_user(cwd, &["pull", "--ff-only", "-q"], Duration::from_secs(120))
            .await
            .map(|_| ())
    }

    /// One pass of automatic pull, for projects that asked. Only a checkout sitting
    /// on the remote's default branch moves, and a failure waits for the next pass.
    pub async fn auto_pull(&self) {
        for project in self.store.list_projects().unwrap_or_default() {
            let wanted = self.preference("auto_pull", Some(&project.id));
            if !project.is_git || !project.trusted || wanted.ok() != Some(json!(true)) {
                continue;
            }
            let cwd = Path::new(&project.path);
            let current = git(cwd, &["branch", "--show-current"])
                .await
                .map(|t| text(&t));
            let default = git(
                cwd,
                &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            )
            .await
            .map(|t| text(&t));
            if let (Ok(current), Ok(default)) = (current, default)
                && default.strip_prefix("origin/") == Some(current.as_str())
                && let Err(error) = self.pull_project(&project.id, "system:auto-pull").await
            {
                tracing::debug!(%error, "automatic pull skipped");
            }
        }
    }

    /// Applies the retention rules, or with `dry_run` only says what they would do.
    pub async fn storage_cleanup(&self, dry_run: bool) -> Result<CleanupReport> {
        let _admission = self.cleanup_policy_gate.write().await;
        let worktree_policies = self.worktree_retention()?;
        let rules = self.preference("storage_cleanup", None)?;
        let mut entries = Vec::new();
        if let Some(age) = days(&rules, "browser_artifacts_after_days") {
            let folder = self.config.data_dir.join("browser-artifacts");
            sweep(&folder, "artifact", age, dry_run, &mut entries);
        }
        if let Some(age) = days(&rules, "logs_after_days") {
            let folder = self.config.data_dir.join("logs");
            sweep(&folder, "log", age, dry_run, &mut entries);
        }
        self.sweep_worktrees(&worktree_policies, dry_run, &mut entries)
            .await?;
        let report = CleanupReport {
            dry_run,
            ran_at: now(),
            entries,
        };
        if !dry_run {
            self.store
                .set_setting(REPORT_SETTING, &serde_json::to_string(&report)?)?;
        }
        Ok(report)
    }

    pub fn cleanup_report(&self) -> Result<Option<CleanupReport>> {
        Ok(self
            .store
            .setting(REPORT_SETTING)?
            .and_then(|text| serde_json::from_str(&text).ok()))
    }

    async fn sweep_worktrees(
        &self,
        policies: &std::collections::BTreeMap<String, Option<i64>>,
        dry_run: bool,
        entries: &mut Vec<CleanupEntry>,
    ) -> Result<()> {
        for project in self.store.list_projects()? {
            let Some(age) = policies.get(&project.id).copied().flatten() else {
                continue;
            };
            for thread in self.store.list_all_threads(&project.id)? {
                let Some(worktree) = &thread.worktree else {
                    continue;
                };
                let settled = thread
                    .lifecycle
                    .as_ref()
                    .and_then(|l| l.settled_at.as_deref())
                    .and_then(parse_time);
                if settled.is_none_or(|at| unix_now() - at < age * DAY)
                    || !Path::new(&worktree.path).exists()
                {
                    continue;
                }
                let root = crate::util::canonicalize(Path::new(&worktree.path))?;
                let mut shared = thread.active_run.is_some();
                // A selected subfolder can be a different project while its live
                // thread still owns files in this same physical worktree.
                for owner in self.store.list_projects()? {
                    shared |= self.store.list_all_threads(&owner.id)?.iter().any(|other| {
                        other.id != thread.id
                            && (other.active_run.is_some()
                                || other
                                    .lifecycle
                                    .as_ref()
                                    .is_none_or(|l| l.settled_at.is_none()))
                            && crate::util::canonicalize(Path::new(&other.cwd))
                                .is_ok_and(|cwd| cwd.starts_with(&root))
                    });
                }
                let mut entry = CleanupEntry {
                    kind: "worktree".to_owned(),
                    path: worktree.path.clone(),
                    removed: false,
                    reason: format!("Settled over {age} days ago"),
                };
                if shared {
                    "Another active thread uses it".clone_into(&mut entry.reason);
                } else if !dry_run {
                    let removed = git(
                        Path::new(&project.path),
                        &["worktree", "remove", &worktree.path],
                    )
                    .await;
                    match removed {
                        Ok(_) => entry.removed = true,
                        Err(error) => entry.reason = error.public_message(),
                    }
                }
                entries.push(entry);
            }
        }
        Ok(())
    }
}
