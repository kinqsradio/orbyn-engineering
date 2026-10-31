//! The single gate every engine action passes: policy first, then a person.
//! Any failure on this path is a denial.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{ActionKind, Approval, ApprovalState, PermissionMode, PolicyEffect};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::error::Result;
use crate::policy;
use crate::store::{AuditRecord, NewApproval, Store};
use crate::util::new_id;

/// Where a run may write.
#[derive(Clone, Debug)]
pub struct WriteScope {
    pub checkout: PathBuf,
    /// Where this engine resolves a relative path: the library for Claude, which
    /// runs there, and the checkout for an engine whose turn runs in it.
    pub engine_cwd: PathBuf,
    /// Inside `checkout` but still off limits: a library thread's `repo/`.
    pub excluded: Vec<PathBuf>,
}

impl WriteScope {
    /// `path` as this engine means it, so a person reads the real target and a
    /// relative path can never be taken for one in the checkout.
    pub fn absolute(&self, path: &str) -> String {
        self.engine_cwd.join(path).to_string_lossy().into_owned()
    }

    /// True when `path` lands inside the checkout after resolving `..` and any
    /// symlink in the part of the path that exists.
    pub fn permits(&self, path: &str) -> bool {
        let full = self.engine_cwd.join(path);
        let Some(resolved) = resolve_existing(&full) else {
            return false;
        };
        let inside = crate::util::canonicalize(&self.checkout)
            .is_ok_and(|checkout| resolved.starts_with(checkout));
        inside
            && !self.excluded.iter().any(|excluded| {
                crate::util::canonicalize(excluded).is_ok_and(|e| resolved.starts_with(e))
            })
    }
}

/// Removes `.` and `..`, then canonicalizes the deepest existing ancestor.
fn resolve_existing(path: &Path) -> Option<PathBuf> {
    let mut plain = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                if !plain.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => plain.push(other),
        }
    }
    let mut existing = plain.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = crate::util::canonicalize(existing) {
            return Some(
                rest.into_iter()
                    .rev()
                    .fold(real, |path, part| path.join(part)),
            );
        }
        rest.push(existing.file_name()?.to_owned());
        existing = existing.parent()?;
    }
}

/// Identifies the run an action belongs to.
#[derive(Clone, Debug)]
pub struct RunScope {
    pub run_id: String,
    pub thread_id: String,
    pub engine: String,
    /// `None` only for callers with no file access at all.
    pub write_scope: Option<WriteScope>,
    pub mode: PermissionMode,
    pub plan: bool,
}

/// True when the thread's mode answers an action nobody wrote a rule for.
/// Computer and browser actions always reach a person or a rule.
fn mode_accepts(mode: PermissionMode, kind: ActionKind) -> bool {
    match (mode, kind) {
        (_, ActionKind::Computer | ActionKind::Browser) | (PermissionMode::Supervised, _) => false,
        (PermissionMode::FullAccess, _) => true,
        (PermissionMode::Auto, ActionKind::Command | ActionKind::FileChange) => true,
        (PermissionMode::AutoEdits, ActionKind::FileChange) => true,
        _ => false,
    }
}

/// One action an engine wants to take.
#[derive(Clone, Debug)]
pub struct ActionAsk {
    pub kind: ActionKind,
    pub target: String,
    pub summary: String,
    pub detail: Value,
    /// Files a write touches; empty means `target` names the file.
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny(String),
}

impl Verdict {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }
}

pub struct ApprovalGate {
    store: Arc<Store>,
    waiters: Mutex<HashMap<String, oneshot::Sender<ApprovalState>>>,
    timeout: Duration,
}

impl ApprovalGate {
    pub fn new(store: Arc<Store>, timeout: Duration) -> Self {
        Self {
            store,
            waiters: Mutex::new(HashMap::new()),
            timeout,
        }
    }

    /// Decides an action, waiting for a person when policy says ask. The audit
    /// row for the outcome is committed before this returns, so it always
    /// precedes the effect. The future can be dropped safely: an abandoned
    /// approval expires rather than staying pending.
    pub async fn request(&self, scope: &RunScope, ask: ActionAsk) -> Verdict {
        match self.request_inner(scope, ask).await {
            Ok(verdict) => verdict,
            Err(error) => {
                tracing::warn!(%error, run_id = %scope.run_id, "approval path failed; denying");
                Verdict::Deny("Orbyn could not reach its approval service.".to_owned())
            }
        }
    }

    /// A write outside the selected checkout is denied before policy, so no rule
    /// and no person can widen a run's reach. A write with no usable path fails closed.
    fn outside_scope(&self, scope: &RunScope, ask: &ActionAsk) -> Result<Option<Verdict>> {
        let (ActionKind::FileChange, Some(write_scope)) = (ask.kind, &scope.write_scope) else {
            return Ok(None);
        };
        let single = [ask.target.clone()];
        let paths = if ask.paths.is_empty() {
            &single[..]
        } else {
            &ask.paths[..]
        };
        let Some(refused) = paths.iter().find(|path| !write_scope.permits(path)) else {
            return Ok(None);
        };
        self.store.append_audit(&AuditRecord {
            actor: format!("engine:{}", scope.engine),
            action: "action.deny".into(),
            target: refused.clone(),
            decision: Some(PolicyEffect::Deny),
            source: "write_scope".into(),
            thread_id: Some(scope.thread_id.clone()),
            run_id: Some(scope.run_id.clone()),
            detail: json!({ "checkout": write_scope.checkout }),
        })?;
        Ok(Some(Verdict::Deny(format!(
            "This run may write only inside {}.",
            write_scope.checkout.display()
        ))))
    }

    async fn request_inner(&self, scope: &RunScope, mut ask: ActionAsk) -> Result<Verdict> {
        if let (ActionKind::FileChange, Some(write_scope)) = (ask.kind, &scope.write_scope)
            && Path::new(&ask.target).is_relative()
        {
            let absolute = write_scope.absolute(&ask.target);
            ask.summary = ask.summary.replace(&ask.target, &absolute);
            ask.target = absolute;
        }
        if let Some(denied) = self.outside_scope(scope, &ask)? {
            return Ok(denied);
        }
        if scope.plan && ask.kind == ActionKind::FileChange {
            return Ok(Verdict::Deny("Plan mode changes nothing.".to_owned()));
        }
        let rules = self.store.list_rules()?;
        let mut decision = policy::evaluate(&rules, ask.kind, &ask.target, &scope.engine);
        if decision.effect == PolicyEffect::Ask
            && decision.rule_id.is_none()
            && mode_accepts(scope.mode, ask.kind)
        {
            decision.effect = PolicyEffect::Allow;
            decision.source = "permission_mode".into();
            decision.reason = "Accepted by the thread's permission mode".into();
        }
        if decision.effect != PolicyEffect::Ask {
            self.store.append_audit(&AuditRecord {
                actor: format!("engine:{}", scope.engine),
                action: format!("action.{}", policy_verb(decision.effect)),
                target: ask.target.clone(),
                decision: Some(decision.effect),
                source: decision.source.clone(),
                thread_id: Some(scope.thread_id.clone()),
                run_id: Some(scope.run_id.clone()),
                detail: json!({
                    "kind": ask.kind,
                    "rule_id": decision.rule_id,
                    "reason": decision.reason,
                }),
            })?;
            return Ok(match decision.effect {
                PolicyEffect::Allow => Verdict::Allow,
                _ => Verdict::Deny(format!("Blocked by policy: {}", decision.reason)),
            });
        }

        // The waiter must exist before the row does, or a fast decision is lost.
        let id = new_id();
        let (sender, receiver) = oneshot::channel();
        self.lock().insert(id.clone(), sender);
        let mut pending = PendingGuard {
            gate: self,
            id: id.clone(),
            settled: false,
        };
        self.store.create_approval(NewApproval {
            id: id.clone(),
            run_id: scope.run_id.clone(),
            engine: scope.engine.clone(),
            kind: ask.kind,
            target: ask.target,
            summary: ask.summary,
            detail: ask.detail,
            decision,
        })?;
        let outcome = tokio::time::timeout(self.timeout, receiver).await;
        pending.settled = true;
        let state = match outcome {
            Ok(Ok(state)) => state,
            // Timeout, or a waiter dropped by shutdown: the store decides what stands.
            _ => {
                self.lock().remove(&id);
                self.store.expire_approval(&id, "system:timeout")?.state
            }
        };
        Ok(match state {
            ApprovalState::Allowed => Verdict::Allow,
            ApprovalState::Denied => Verdict::Deny("Denied in Orbyn.".to_owned()),
            _ => Verdict::Deny("The approval expired without a decision.".to_owned()),
        })
    }

    /// Records a decision and wakes the waiter. The durable state changes first.
    pub fn decide(&self, id: &str, allow: bool, remember: bool, actor: &str) -> Result<Approval> {
        let approval = self.store.decide_approval(id, allow, remember, actor)?;
        self.wake(&approval.id, approval.state);
        Ok(approval)
    }

    /// Expires every open approval of a run so a blocked engine hears a denial.
    pub fn expire_run(&self, thread_id: &str, run_id: &str, actor: &str) -> Result<()> {
        for approval in self.store.pending_for_thread(thread_id)? {
            if approval.run_id == run_id {
                let standing = self.store.expire_approval(&approval.id, actor)?;
                self.wake(&standing.id, standing.state);
            }
        }
        Ok(())
    }

    /// Wakes the waiters of approvals that `finish_run` expired.
    pub fn settle(&self, approvals: &[Approval]) {
        for approval in approvals {
            self.wake(&approval.id, approval.state);
        }
    }

    fn wake(&self, id: &str, state: ApprovalState) {
        if let Some(sender) = self.lock().remove(id) {
            let _ = sender.send(state);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<ApprovalState>>> {
        self.waiters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn policy_verb(effect: PolicyEffect) -> &'static str {
    match effect {
        PolicyEffect::Allow => "allow",
        PolicyEffect::Ask => "ask",
        PolicyEffect::Deny => "deny",
    }
}

/// Expires the approval if `request` is dropped before an outcome, for example
/// when an MCP client disconnects during its long poll.
struct PendingGuard<'a> {
    gate: &'a ApprovalGate,
    id: String,
    settled: bool,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.gate.lock().remove(&self.id);
        if let Err(error) = self
            .gate
            .store
            .expire_approval(&self.id, "system:abandoned")
        {
            // A row that was never created is not an error here.
            tracing::debug!(%error, "abandoned approval had nothing to expire");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Admission, NewThread};
    use crate::testing::TempDir;
    use orbyn_contracts::{CreatePolicyRule, RunState};

    struct Fixture {
        _dir: TempDir,
        store: Arc<Store>,
        scope: RunScope,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new();
        let store = Arc::new(Store::open(&dir.path().join("db"), "e").unwrap());
        let project = store
            .add_project(crate::store::NewProject {
                path: "/r",
                name: "r",
                is_git: false,
                managed: false,
                scratch: false,
            })
            .unwrap();
        store.trust_project(&project.id, "t").unwrap();
        let thread = store
            .create_thread(NewThread {
                project_id: project.id,
                title: "t".into(),
                engine: "fake".into(),
                model: None,
                cwd: "/r".into(),
                worktree: None,
                skill_profile: None,
                parent_thread_id: None,
                relation: None,
                scratch: false,
            })
            .unwrap();
        let run = store
            .admit_run(Admission {
                thread_id: &thread.id,
                prompt: "p",
                actor: "t",
            })
            .unwrap();
        store.mark_starting(&run.id).unwrap();
        store.mark_running(&run.id).unwrap();
        Fixture {
            _dir: dir,
            store,
            scope: RunScope {
                run_id: run.id,
                thread_id: thread.id,
                engine: "fake".into(),
                write_scope: None,
                mode: PermissionMode::Supervised,
                plan: false,
            },
        }
    }

    fn ask() -> ActionAsk {
        ActionAsk {
            kind: ActionKind::Command,
            target: "ls".into(),
            summary: "ls".into(),
            detail: Value::Null,
            paths: Vec::new(),
        }
    }

    fn rule(store: &Store, effect: PolicyEffect) {
        store
            .add_rule(
                &CreatePolicyRule {
                    effect,
                    kind: ActionKind::Command,
                    pattern: "*".into(),
                    engine: None,
                    note: None,
                },
                "t",
            )
            .unwrap();
    }

    async fn next_pending(store: &Store, thread: &str) -> Approval {
        loop {
            if let Some(approval) = store.pending_for_thread(thread).unwrap().pop() {
                return approval;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    #[test]
    fn modes_widen_only_what_they_name() {
        use ActionKind::{Browser, Command, Computer, FileChange, Network};
        use PermissionMode::{Auto, AutoEdits, FullAccess, Supervised};
        assert!(!mode_accepts(Supervised, FileChange));
        assert!(mode_accepts(AutoEdits, FileChange));
        assert!(!mode_accepts(AutoEdits, Command));
        assert!(mode_accepts(Auto, Command));
        assert!(!mode_accepts(Auto, Network));
        assert!(mode_accepts(FullAccess, Network));
        for kind in [Computer, Browser] {
            assert!(!mode_accepts(FullAccess, kind), "{kind:?}");
        }
    }

    #[tokio::test]
    async fn full_access_still_loses_to_a_deny_rule_and_to_the_write_scope() {
        let mut f = fixture();
        f.scope.mode = PermissionMode::FullAccess;
        let dir = TempDir::new();
        std::fs::create_dir_all(dir.path().join("checkout")).unwrap();
        f.scope.write_scope = Some(WriteScope {
            checkout: dir.path().join("checkout"),
            engine_cwd: dir.path().to_path_buf(),
            excluded: Vec::new(),
        });
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_secs(1));
        assert!(gate.request(&f.scope, ask()).await.is_allowed());
        let outside = ActionAsk {
            kind: ActionKind::FileChange,
            target: "../elsewhere".into(),
            summary: "w".into(),
            detail: Value::Null,
            paths: Vec::new(),
        };
        assert!(!gate.request(&f.scope, outside).await.is_allowed());
        rule(&f.store, PolicyEffect::Deny);
        assert!(!gate.request(&f.scope, ask()).await.is_allowed());
    }

    #[tokio::test]
    async fn plan_mode_refuses_edits_without_asking() {
        let mut f = fixture();
        f.scope.plan = true;
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_secs(1));
        let edit = ActionAsk {
            kind: ActionKind::FileChange,
            target: "a".into(),
            summary: "w".into(),
            detail: Value::Null,
            paths: Vec::new(),
        };
        assert!(!gate.request(&f.scope, edit).await.is_allowed());
        assert!(
            f.store
                .pending_for_thread(&f.scope.thread_id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn write_scope_resolves_traversal_and_symlinks() {
        let dir = TempDir::new();
        let checkout = crate::util::canonicalize(dir.path())
            .unwrap()
            .join("repo/app");
        std::fs::create_dir_all(checkout.join("src")).unwrap();
        let root = checkout.parent().unwrap().parent().unwrap().to_path_buf();
        let scope = WriteScope {
            checkout: checkout.clone(),
            engine_cwd: root.clone(),
            excluded: Vec::new(),
        };
        assert!(scope.permits(checkout.join("src/new.rs").to_str().unwrap()));
        assert!(scope.permits("repo/app/deep/new/file.rs"));
        assert!(!scope.permits("AGENTS.md"));
        assert!(!scope.permits("repo/app/../../skills/x"));
        assert!(!scope.permits(root.join("skills/x").to_str().unwrap()));
        assert!(!scope.permits("/etc/hosts"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, checkout.join("escape")).unwrap();
            assert!(!scope.permits("repo/app/escape/AGENTS.md"));
        }
    }

    #[tokio::test]
    async fn write_outside_the_checkout_is_denied_even_with_an_allow_rule() {
        let mut f = fixture();
        let dir = TempDir::new();
        std::fs::create_dir_all(dir.path().join("checkout")).unwrap();
        f.scope.write_scope = Some(WriteScope {
            checkout: dir.path().join("checkout"),
            engine_cwd: dir.path().to_path_buf(),
            excluded: Vec::new(),
        });
        f.store
            .add_rule(
                &CreatePolicyRule {
                    effect: PolicyEffect::Allow,
                    kind: ActionKind::FileChange,
                    pattern: "*".into(),
                    engine: None,
                    note: None,
                },
                "t",
            )
            .unwrap();
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_secs(1));
        let write = |path: &str, paths: Vec<String>| ActionAsk {
            kind: ActionKind::FileChange,
            target: path.to_owned(),
            summary: "w".into(),
            detail: Value::Null,
            paths,
        };
        assert!(
            !gate
                .request(&f.scope, write("skills/x", Vec::new()))
                .await
                .is_allowed()
        );
        let mixed = vec!["checkout/ok".to_owned(), "skills/x".to_owned()];
        assert!(
            !gate
                .request(&f.scope, write("many", mixed))
                .await
                .is_allowed()
        );
        assert!(
            gate.request(&f.scope, write("checkout/ok", Vec::new()))
                .await
                .is_allowed()
        );
        let audit = f.store.list_audit(Some(&f.scope.thread_id), 5).unwrap();
        assert!(audit.iter().any(|row| row.source == "write_scope"));
    }

    #[tokio::test]
    async fn deny_rule_needs_no_person_and_is_audited() {
        let f = fixture();
        rule(&f.store, PolicyEffect::Deny);
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_secs(1));
        assert!(!gate.request(&f.scope, ask()).await.is_allowed());
        let audit = f.store.list_audit(Some(&f.scope.thread_id), 5).unwrap();
        assert_eq!(audit[0].action, "action.deny");
        assert_eq!(audit[0].decision, Some(PolicyEffect::Deny));
    }

    #[tokio::test]
    async fn allow_rule_passes_without_a_person() {
        let f = fixture();
        rule(&f.store, PolicyEffect::Allow);
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_secs(1));
        assert_eq!(gate.request(&f.scope, ask()).await, Verdict::Allow);
        assert!(
            f.store
                .pending_for_thread(&f.scope.thread_id)
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn person_decides_and_waiter_wakes() {
        let f = fixture();
        let gate = Arc::new(ApprovalGate::new(f.store.clone(), Duration::from_secs(5)));
        let waiting = {
            let (gate, scope) = (gate.clone(), f.scope.clone());
            tokio::spawn(async move { gate.request(&scope, ask()).await })
        };
        let approval = next_pending(&f.store, &f.scope.thread_id).await;
        gate.decide(&approval.id, true, false, "person").unwrap();
        assert_eq!(waiting.await.unwrap(), Verdict::Allow);
    }

    #[tokio::test]
    async fn timeout_denies_and_expires() {
        let f = fixture();
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_millis(20));
        assert!(!gate.request(&f.scope, ask()).await.is_allowed());
        let expired = f
            .store
            .list_approvals(Some(ApprovalState::Expired))
            .unwrap();
        assert_eq!(expired.len(), 1);
    }

    #[tokio::test]
    async fn dropped_request_expires_its_approval() {
        let f = fixture();
        let gate = Arc::new(ApprovalGate::new(f.store.clone(), Duration::from_secs(5)));
        let waiting = {
            let (gate, scope) = (gate.clone(), f.scope.clone());
            tokio::spawn(async move { gate.request(&scope, ask()).await })
        };
        let approval = next_pending(&f.store, &f.scope.thread_id).await;
        waiting.abort();
        let _ = waiting.await;
        assert_eq!(
            f.store.approval(&approval.id).unwrap().state,
            ApprovalState::Expired
        );
        assert_eq!(
            f.store.run(&f.scope.run_id).unwrap().state,
            RunState::Running
        );
    }

    #[tokio::test]
    async fn finished_run_denies_immediately() {
        let f = fixture();
        f.store
            .finish_run(&f.scope.run_id, RunState::Completed, None)
            .unwrap();
        let gate = ApprovalGate::new(f.store.clone(), Duration::from_secs(5));
        assert!(!gate.request(&f.scope, ask()).await.is_allowed());
    }

    #[tokio::test]
    async fn run_end_wakes_waiters_with_denial() {
        let f = fixture();
        let gate = Arc::new(ApprovalGate::new(f.store.clone(), Duration::from_secs(5)));
        let waiting = {
            let (gate, scope) = (gate.clone(), f.scope.clone());
            tokio::spawn(async move { gate.request(&scope, ask()).await })
        };
        next_pending(&f.store, &f.scope.thread_id).await;
        let (_, expired) = f
            .store
            .finish_run(&f.scope.run_id, RunState::Failed, Some("exit"))
            .unwrap();
        gate.settle(&expired);
        assert!(!waiting.await.unwrap().is_allowed());
    }

    #[test]
    fn relative_paths_mean_what_the_engine_means_and_symlinks_cannot_escape() {
        let dir = crate::testing::TempDir::new();
        let library = dir.path().join("library");
        let checkout = dir.path().join("work/app");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::create_dir_all(&checkout).unwrap();
        let claude = WriteScope {
            checkout: checkout.clone(),
            engine_cwd: library.clone(),
            excluded: Vec::new(),
        };
        let codex = WriteScope {
            checkout: checkout.clone(),
            engine_cwd: checkout.clone(),
            excluded: Vec::new(),
        };
        assert!(!claude.permits("a.txt"), "that is the library's a.txt");
        assert!(codex.permits("a.txt"));
        assert!(claude.permits(checkout.join("a.txt").to_str().unwrap()));
        assert!(!codex.permits("../other/a.txt"));
        assert!(!codex.permits(library.join("a.txt").to_str().unwrap()));
        assert_eq!(
            claude.absolute("a.txt"),
            library.join("a.txt").to_string_lossy()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&library, checkout.join("escape")).unwrap();
            assert!(!codex.permits("escape/a.txt"));
            assert!(!claude.permits(checkout.join("escape/a.txt").to_str().unwrap()));
        }
    }
}
