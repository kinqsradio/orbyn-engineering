//! The computer gateway. The order is fixed and is the point of this module:
//! resolve the target, evaluate policy, write audit, then act. A denied action
//! never reaches a backend.

pub mod cdp;
pub mod desktop;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use orbyn_contracts::{ActionKind, ComputerAction, ComputerResult, ComputerStatus, PolicyEffect};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::approvals::{ActionAsk, ApprovalGate, RunScope};
use crate::error::{CoreError, Result};
use crate::policy;
use crate::store::{AuditRecord, Store};
use cdp::BrowserSession;

/// A concrete action after its target is known.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedAction {
    pub kind: ActionKind,
    pub target: String,
    pub summary: String,
    pub command: ComputerCommand,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ComputerCommand {
    BrowserNavigate { url: String },
    BrowserText,
    BrowserScreenshot,
    BrowserClick { selector: String },
    Desktop { command: String, args: Vec<String> },
}

/// The actor side of the gateway, separated so its ordering is testable.
#[async_trait]
pub trait ComputerBackend: Send + Sync {
    /// Finds what an action touches. Reads only: it may ask the browser where it
    /// is, and must not change anything.
    async fn resolve(&self, action: &ComputerAction) -> Result<ResolvedAction>;

    async fn perform(&self, action: &ResolvedAction) -> Result<Value>;

    fn status(&self) -> ComputerStatus;

    async fn shutdown(&self) {}
}

pub struct ComputerGateway {
    store: Arc<Store>,
    gate: Arc<ApprovalGate>,
    backend: Arc<dyn ComputerBackend>,
}

/// Who is acting. A run can wait for a person; a direct call cannot.
pub enum Caller<'a> {
    Run(&'a RunScope),
    Direct { thread_id: &'a str, actor: &'a str },
}

impl ComputerGateway {
    pub fn new(
        store: Arc<Store>,
        gate: Arc<ApprovalGate>,
        backend: Arc<dyn ComputerBackend>,
    ) -> Self {
        Self {
            store,
            gate,
            backend,
        }
    }

    pub fn status(&self) -> ComputerStatus {
        self.backend.status()
    }

    pub async fn shutdown(&self) {
        self.backend.shutdown().await;
    }

    pub async fn act(&self, caller: Caller<'_>, action: ComputerAction) -> Result<ComputerResult> {
        let resolved = self.backend.resolve(&action).await?;
        let ask = ActionAsk {
            kind: resolved.kind,
            target: resolved.target.clone(),
            summary: resolved.summary.clone(),
            detail: json!({ "action": action.action, "target": resolved.target, "args": action.args }),
            paths: Vec::new(),
        };
        let (thread_id, run_id, actor) = match &caller {
            Caller::Run(scope) => {
                let verdict = self.gate.request(scope, ask).await;
                if let crate::approvals::Verdict::Deny(reason) = verdict {
                    return Err(CoreError::PolicyDenied(reason));
                }
                (
                    scope.thread_id.clone(),
                    Some(scope.run_id.clone()),
                    format!("engine:{}", scope.engine),
                )
            }
            Caller::Direct { thread_id, actor } => {
                self.check_direct(thread_id, actor, &ask)?;
                ((*thread_id).to_owned(), None, (*actor).to_owned())
            }
        };
        self.store.append_audit(&AuditRecord {
            actor: actor.clone(),
            action: "computer.act".into(),
            target: resolved.target.clone(),
            decision: Some(PolicyEffect::Allow),
            source: "gateway".into(),
            thread_id: Some(thread_id.clone()),
            run_id: run_id.clone(),
            detail: json!({ "action": action.action, "kind": resolved.kind }),
        })?;
        let outcome = self.backend.perform(&resolved).await;
        self.store.append_audit(&AuditRecord {
            actor,
            action: "computer.result".into(),
            target: resolved.target.clone(),
            decision: None,
            source: "gateway".into(),
            thread_id: Some(thread_id),
            run_id,
            detail: json!({
                "ok": outcome.is_ok(),
                "error": outcome.as_ref().err().map(ToString::to_string),
            }),
        })?;
        Ok(ComputerResult {
            ok: true,
            target: resolved.target,
            data: outcome?,
        })
    }

    /// A direct call has no run to pause, so `ask` cannot be answered and is a
    /// refusal. The denial is audited like any other.
    fn check_direct(&self, thread_id: &str, actor: &str, ask: &ActionAsk) -> Result<()> {
        let rules = self.store.list_rules()?;
        let decision = policy::evaluate(&rules, ask.kind, &ask.target, "direct");
        let allowed = decision.effect == PolicyEffect::Allow;
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: if allowed {
                "action.allow".into()
            } else {
                "action.deny".into()
            },
            target: ask.target.clone(),
            decision: Some(if allowed {
                PolicyEffect::Allow
            } else {
                PolicyEffect::Deny
            }),
            source: decision.source,
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail: json!({ "reason": decision.reason, "kind": ask.kind }),
        })?;
        if allowed {
            Ok(())
        } else {
            Err(CoreError::PolicyDenied(
                "This action needs an allow rule, or a run that can ask for approval.".into(),
            ))
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ComputerConfig {
    pub desktop_program: Option<String>,
    pub browser_path: Option<PathBuf>,
    pub profile_dir: PathBuf,
    pub headless: bool,
}

/// Desktop through the `agent-desktop` sidecar, browser through CDP.
pub struct LocalBackend {
    config: ComputerConfig,
    browser: Mutex<Option<BrowserSession>>,
}

impl LocalBackend {
    pub fn new(config: ComputerConfig) -> Self {
        Self {
            config,
            browser: Mutex::new(None),
        }
    }

    fn browser_path(&self) -> Option<PathBuf> {
        self.config.browser_path.clone().or_else(cdp::find_browser)
    }

    fn desktop(&self) -> Option<crate::process::ResolvedCommand> {
        desktop::find(self.config.desktop_program.as_deref())
    }

    async fn current_url(&self) -> Result<String> {
        let mut browser = self.browser.lock().await;
        match browser.as_mut() {
            Some(session) => session.current_url().await,
            None => Ok("about:blank".to_owned()),
        }
    }

    async fn with_browser<T>(
        &self,
        work: impl AsyncFnOnce(&mut BrowserSession) -> Result<T>,
    ) -> Result<T> {
        let mut browser = self.browser.lock().await;
        if browser.is_none() {
            let path = self.browser_path().ok_or_else(|| {
                CoreError::Computer("Install Chrome or Edge to use browser control.".into())
            })?;
            *browser = Some(
                BrowserSession::launch(&path, &self.config.profile_dir, self.config.headless)
                    .await?,
            );
        }
        let session = browser
            .as_mut()
            .ok_or_else(|| CoreError::Internal("browser session vanished".into()))?;
        let outcome = work(session).await;
        if matches!(outcome, Err(CoreError::Computer(_))) && !session.is_alive().await {
            *browser = None;
        }
        outcome
    }
}

#[async_trait]
impl ComputerBackend for LocalBackend {
    async fn resolve(&self, action: &ComputerAction) -> Result<ResolvedAction> {
        let name = action.action.as_str();
        let args = string_args(&action.args);
        if let Some(command) = name.strip_prefix("desktop.") {
            if !desktop::is_known(command) {
                return Err(CoreError::Invalid(format!(
                    "{command} is not a desktop action Orbyn offers."
                )));
            }
            let target = format!("{command} {}", action.target).trim().to_owned();
            let mut command_args = Vec::new();
            if !action.target.is_empty() {
                command_args.push(action.target.clone());
            }
            command_args.extend(args);
            return Ok(ResolvedAction {
                kind: ActionKind::Computer,
                summary: format!("Desktop: {target}"),
                target,
                command: ComputerCommand::Desktop {
                    command: command.to_owned(),
                    args: command_args,
                },
            });
        }
        let browser = |target: String, summary: String, command| ResolvedAction {
            kind: ActionKind::Browser,
            target,
            summary,
            command,
        };
        match name {
            "browser.navigate" => {
                let url = cdp::normalize_url(&action.target)?;
                Ok(browser(
                    url.clone(),
                    format!("Open {url}"),
                    ComputerCommand::BrowserNavigate { url },
                ))
            }
            "browser.text" => {
                let url = self.current_url().await?;
                Ok(browser(
                    url.clone(),
                    format!("Read {url}"),
                    ComputerCommand::BrowserText,
                ))
            }
            "browser.screenshot" => {
                let url = self.current_url().await?;
                Ok(browser(
                    url.clone(),
                    format!("Capture {url}"),
                    ComputerCommand::BrowserScreenshot,
                ))
            }
            "browser.click" => {
                let url = self.current_url().await?;
                if action.target.is_empty() {
                    return Err(CoreError::Invalid("A click needs a CSS selector.".into()));
                }
                Ok(browser(
                    url.clone(),
                    format!("Click {} on {url}", action.target),
                    ComputerCommand::BrowserClick {
                        selector: action.target.clone(),
                    },
                ))
            }
            other => Err(CoreError::Invalid(format!("Unknown action {other}."))),
        }
    }

    async fn perform(&self, action: &ResolvedAction) -> Result<Value> {
        match &action.command {
            ComputerCommand::BrowserNavigate { url } => {
                self.with_browser(async |session| session.navigate(url).await)
                    .await
            }
            ComputerCommand::BrowserText => {
                self.with_browser(async |session| session.text().await)
                    .await
            }
            ComputerCommand::BrowserScreenshot => {
                self.with_browser(async |session| session.screenshot().await)
                    .await
            }
            ComputerCommand::BrowserClick { selector } => {
                self.with_browser(async |session| session.click(selector).await)
                    .await
            }
            ComputerCommand::Desktop { command, args } => {
                let sidecar = self
                    .desktop()
                    .ok_or_else(|| CoreError::Computer("agent-desktop is not installed.".into()))?;
                desktop::run(&sidecar, command, args).await
            }
        }
    }

    fn status(&self) -> ComputerStatus {
        let desktop = self.desktop();
        let browser = self.browser_path();
        ComputerStatus {
            desktop_control: desktop.is_some(),
            desktop_path: desktop.map(|command| display(&command.path)),
            desktop_version: None,
            browser_control: browser.is_some(),
            browser_path: browser.as_deref().map(display),
            problem: None,
        }
    }

    async fn shutdown(&self) {
        *self.browser.lock().await = None;
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn string_args(args: &Value) -> Vec<String> {
    match args {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.clone()),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Admission, NewThread};
    use crate::testing::TempDir;
    use orbyn_contracts::CreatePolicyRule;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Records whether the audit row existed when the effect happened.
    struct RecordingBackend {
        store: Arc<Store>,
        performed: AtomicUsize,
        audited_first: AtomicUsize,
    }

    #[async_trait]
    impl ComputerBackend for RecordingBackend {
        async fn resolve(&self, action: &ComputerAction) -> Result<ResolvedAction> {
            Ok(ResolvedAction {
                kind: ActionKind::Browser,
                target: action.target.clone(),
                summary: "x".into(),
                command: ComputerCommand::BrowserText,
            })
        }

        async fn perform(&self, _: &ResolvedAction) -> Result<Value> {
            self.performed.fetch_add(1, Ordering::SeqCst);
            let audit = self.store.list_audit(None, 5)?;
            if audit.iter().any(|row| row.action == "computer.act") {
                self.audited_first.fetch_add(1, Ordering::SeqCst);
            }
            Ok(json!("done"))
        }

        fn status(&self) -> ComputerStatus {
            unreachable!("not used")
        }
    }

    struct Fixture {
        _dir: TempDir,
        store: Arc<Store>,
        backend: Arc<RecordingBackend>,
        gateway: ComputerGateway,
        gate: Arc<ApprovalGate>,
        scope: RunScope,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new();
        let store = Arc::new(Store::open(&dir.path().join("db"), "e").unwrap());
        let project = store.add_project("/r", "r", false).unwrap();
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
        let backend = Arc::new(RecordingBackend {
            store: store.clone(),
            performed: AtomicUsize::new(0),
            audited_first: AtomicUsize::new(0),
        });
        let gate = Arc::new(ApprovalGate::new(store.clone(), Duration::from_secs(5)));
        let gateway = ComputerGateway::new(store.clone(), gate.clone(), backend.clone());
        Fixture {
            _dir: dir,
            store,
            backend,
            gateway,
            gate,
            scope: RunScope {
                run_id: run.id,
                thread_id: thread.id,
                engine: "fake".into(),
                write_scope: None,
                mode: orbyn_contracts::PermissionMode::Supervised,
                plan: false,
            },
        }
    }

    fn action() -> ComputerAction {
        ComputerAction {
            action: "browser.text".into(),
            target: "https://example.com".into(),
            args: Value::Null,
        }
    }

    fn rule(store: &Store, effect: PolicyEffect) {
        store
            .add_rule(
                &CreatePolicyRule {
                    effect,
                    kind: ActionKind::Browser,
                    pattern: "https://*".into(),
                    engine: None,
                    note: None,
                },
                "t",
            )
            .unwrap();
    }

    #[tokio::test]
    async fn allowed_action_is_audited_before_its_effect() {
        let f = fixture();
        rule(&f.store, PolicyEffect::Allow);
        let result = f
            .gateway
            .act(Caller::Run(&f.scope), action())
            .await
            .unwrap();
        assert_eq!(result.data, json!("done"));
        assert_eq!(f.backend.performed.load(Ordering::SeqCst), 1);
        assert_eq!(f.backend.audited_first.load(Ordering::SeqCst), 1);
        let audit = f.store.list_audit(Some(&f.scope.thread_id), 10).unwrap();
        assert_eq!(audit[0].action, "computer.result");
        assert_eq!(audit[1].action, "computer.act");
    }

    #[tokio::test]
    async fn denied_action_never_reaches_the_backend() {
        let f = fixture();
        rule(&f.store, PolicyEffect::Deny);
        let denied = f.gateway.act(Caller::Run(&f.scope), action()).await;
        assert!(matches!(denied, Err(CoreError::PolicyDenied(_))));
        assert_eq!(f.backend.performed.load(Ordering::SeqCst), 0);
        let audit = f.store.list_audit(Some(&f.scope.thread_id), 10).unwrap();
        assert_eq!(audit[0].action, "action.deny");
        assert!(audit.iter().all(|row| row.action != "computer.act"));
    }

    #[tokio::test]
    async fn default_is_ask_and_a_person_decides_before_any_effect() {
        let f = fixture();
        let gateway = Arc::new(f.gateway);
        let scope = f.scope.clone();
        let acting = {
            let gateway = gateway.clone();
            tokio::spawn(async move { gateway.act(Caller::Run(&scope), action()).await })
        };
        let approval = loop {
            if let Some(found) = f
                .store
                .pending_for_thread(&f.scope.thread_id)
                .unwrap()
                .pop()
            {
                break found;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        };
        assert_eq!(f.backend.performed.load(Ordering::SeqCst), 0);
        f.gate.decide(&approval.id, false, false, "person").unwrap();
        assert!(acting.await.unwrap().is_err());
        assert_eq!(f.backend.performed.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn direct_call_cannot_wait_so_ask_refuses_and_audits() {
        let f = fixture();
        let caller = Caller::Direct {
            thread_id: &f.scope.thread_id,
            actor: "user",
        };
        assert!(matches!(
            f.gateway.act(caller, action()).await,
            Err(CoreError::PolicyDenied(_))
        ));
        assert_eq!(f.backend.performed.load(Ordering::SeqCst), 0);
        let audit = f.store.list_audit(Some(&f.scope.thread_id), 1).unwrap();
        assert_eq!(audit[0].action, "action.deny");
    }

    #[tokio::test]
    async fn local_backend_rejects_unknown_desktop_commands_and_non_web_urls() {
        let dir = TempDir::new();
        let backend = LocalBackend::new(ComputerConfig {
            profile_dir: dir.path().to_path_buf(),
            ..ComputerConfig::default()
        });
        let unknown = ComputerAction {
            action: "desktop.format-disk".into(),
            target: String::new(),
            args: Value::Null,
        };
        assert!(backend.resolve(&unknown).await.is_err());
        let file = ComputerAction {
            action: "browser.navigate".into(),
            target: "file:///etc/passwd".into(),
            args: Value::Null,
        };
        assert!(backend.resolve(&file).await.is_err());
    }
}
