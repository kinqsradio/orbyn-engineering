//! Local settings targets derived from registered physical projects. Git is read
//! without transport or helpers. Remote URLs never leave this module or enter storage.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use futures_util::{StreamExt, stream};
use orbyn_contracts::{
    Project, ProjectGroupingMode, ProjectScopeCatalog, ProjectScopeCheckout, ProjectScopeGroup,
    ProjectScopeUnavailableReason, ProjectScopesQuery, ProjectSettingsSelection,
    ResolvedProjectSettingsScope,
};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::process::ManagedChild;
use crate::util::{canonicalize, sha256_hex};

const MAX_PROJECTS: usize = 512;
const MAX_PATH_BYTES: usize = 8 * 1024;
const MAX_REMOTE_BYTES: usize = 8 * 1024;
const MAX_CAPTURE: u64 = 64 * 1024;
const CATALOG_BUDGET: Duration = Duration::from_secs(3);
const GIT_BUDGET: Duration = Duration::from_secs(2);
const REAP_BUDGET: Duration = Duration::from_secs(1);

fn opaque(namespace: &str, pieces: &[&str]) -> String {
    let mut bytes = Vec::new();
    for piece in pieces {
        bytes.extend_from_slice(&(piece.len() as u64).to_be_bytes());
        bytes.extend_from_slice(piece.as_bytes());
    }
    format!("{namespace}_{}", sha256_hex(&bytes))
}

struct Repository {
    canonical: String,
    label: String,
}

/// Equivalence is deliberately limited to ordinary HTTPS/SSH/SCP locators.
/// Keep path case and explicit ports; discard userinfo, query and fragment.
fn remote_repository(raw: &str) -> Option<Repository> {
    if raw.is_empty()
        || raw.len() > MAX_REMOTE_BYTES
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let (authority, path) = if let Some((scheme, rest)) = raw.split_once("://") {
        if !matches!(scheme.to_ascii_lowercase().as_str(), "https" | "ssh") {
            return None;
        }
        let parsed = reqwest::Url::parse(raw).ok()?;
        parsed.host_str()?;
        let boundary = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        (
            &rest[..boundary],
            rest.get(boundary..)?.trim_start_matches('/'),
        )
    } else {
        if raw.contains("::") || raw.contains('\\') {
            return None;
        }
        let (host, path) = raw.split_once(':')?;
        if host.contains('/')
            || host.len() == 1
            || matches!(host, "http" | "https" | "ssh" | "file" | "git" | "ext")
        {
            return None;
        }
        (host, path)
    };
    let endpoint = authority.rsplit('@').next()?;
    // Validate the endpoint without retaining or returning any userinfo.
    reqwest::Url::parse(&format!("ssh://{endpoint}/"))
        .ok()?
        .host_str()?;
    let path = path.split(['?', '#']).next()?.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if path.is_empty()
        || path.contains('\\')
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return None;
    }
    let lowered = path.to_ascii_lowercase();
    if lowered.contains("%2f") || lowered.contains("%5c") || lowered.contains("%2e") {
        return None;
    }
    Some(Repository {
        canonical: format!("{}/{path}", endpoint.to_ascii_lowercase()),
        label: path.to_owned(),
    })
}

fn local_remote(raw: &str) -> bool {
    if raw.to_ascii_lowercase().starts_with("file:") {
        return true;
    }
    if raw.contains("://") {
        return false;
    }
    let Some(colon) = raw.find(':') else {
        return true;
    };
    (colon == 1 && raw.as_bytes().first().is_some_and(u8::is_ascii_alphabetic))
        || raw[..colon].contains(['/', '\\'])
}

fn repository_from_config(bytes: &[u8]) -> std::result::Result<Option<Repository>, ()> {
    let mut remotes = BTreeMap::new();
    for entry in bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let entry = std::str::from_utf8(entry).map_err(|_| ())?;
        let (key, value) = entry.split_once('\n').ok_or(())?;
        // Do not follow arbitrary include files or guess Git URL rewrites.
        if key.starts_with("include.") || key.starts_with("includeif.") || key.starts_with("url.") {
            return Err(());
        }
        let name = key
            .strip_prefix("remote.")
            .and_then(|key| key.strip_suffix(".url"))
            .ok_or(())?;
        if name.is_empty() || value.len() > MAX_REMOTE_BYTES {
            return Err(());
        }
        // Git fetch uses the first URL, including across common/worktree config.
        remotes.entry(name).or_insert(value);
    }
    for name in ["origin", "upstream"] {
        if let Some(raw) = remotes.get(name)
            && !local_remote(raw)
        {
            return Ok(remote_repository(raw));
        }
    }
    Ok(remotes
        .values()
        .filter(|raw| !local_remote(raw))
        .find_map(|raw| remote_repository(raw)))
}

async fn metadata(path: &Path, args: &[&str], deadline: Instant) -> Option<(i32, Vec<u8>)> {
    let budget = deadline
        .saturating_duration_since(Instant::now())
        .min(GIT_BUDGET);
    if budget.is_zero() {
        return None;
    }
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.allow=never",
        ])
        .arg("-C")
        .arg(path)
        .args(args)
        .current_dir(std::env::temp_dir())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::child_env::for_tool(command.as_std_mut());
    // Metadata must come from this checkout, not an enclosing Git invocation.
    // Disable trace sinks too: config tracing can otherwise emit remote userinfo.
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if text.starts_with("GIT_TRACE")
            || text.starts_with("GIT_CONFIG_")
            || matches!(
                text.as_ref(),
                "GIT_DIR"
                    | "GIT_WORK_TREE"
                    | "GIT_COMMON_DIR"
                    | "GIT_INDEX_FILE"
                    | "GIT_CONFIG"
                    | "GIT_CEILING_DIRECTORIES"
                    | "GIT_DISCOVERY_ACROSS_FILESYSTEM"
            )
        {
            command.env_remove(name);
        }
    }
    #[cfg(unix)]
    let null = "/dev/null";
    #[cfg(windows)]
    let null = "NUL";
    command
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_CONFIG_SYSTEM", null);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = ManagedChild::spawn(command).ok()?;
    let mut stdout = child.child_mut().stdout.take()?.take(MAX_CAPTURE + 1);
    let result = tokio::time::timeout(budget, async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.ok()?;
        if bytes.len() as u64 > MAX_CAPTURE {
            return None;
        }
        Some((child.wait().await.ok()?.code()?, bytes))
    })
    .await
    .ok()
    .flatten();
    drop(stdout);
    child.terminate();
    if !matches!(
        tokio::time::timeout(REAP_BUDGET, child.wait()).await,
        Ok(Ok(_))
    ) {
        let _ = tokio::time::timeout(REAP_BUDGET, child.child_mut().kill()).await;
    }
    result
}

async fn checkout(
    project: Project,
    mode: ProjectGroupingMode,
    deadline: Instant,
) -> ProjectScopeCheckout {
    let mut member = ProjectScopeCheckout {
        physical_key: opaque("checkout", &[&project.path]),
        project_id: project.id,
        name: project.name,
        path: None,
        repository_key: None,
        repository_label: None,
        repository_relative_path: None,
        grouping_mode: mode,
        metadata_complete: false,
        unavailable: None,
    };
    if project.path.len() > MAX_PATH_BYTES {
        member.unavailable = Some(ProjectScopeUnavailableReason::InvalidPath);
        return member;
    }
    member.path = Some(project.path.clone());
    let path = Path::new(&project.path);
    let Ok(real) = canonicalize(path) else {
        member.unavailable = Some(ProjectScopeUnavailableReason::CheckoutMissing);
        return member;
    };
    if !real.is_dir() {
        member.unavailable = Some(ProjectScopeUnavailableReason::CheckoutMissing);
        return member;
    }
    if real != path {
        member.unavailable = Some(ProjectScopeUnavailableReason::CheckoutChanged);
        return member;
    }
    // Inspect configuration without includes before a command that could load them.
    // Global/system configuration and caller-provided config are disabled in metadata.
    let repository = match metadata(
        path,
        &[
            "config",
            "--no-includes",
            "--null",
            "--get-regexp",
            r"^(remote\..*\.url|include\..*|includeif\..*|url\..*\.(insteadof|pushinsteadof))$",
        ],
        deadline,
    )
    .await
    {
        Some((0, bytes)) => match repository_from_config(&bytes) {
            Ok(repository) => repository,
            Err(()) => return member,
        },
        Some((1, _)) => None,
        _ => return member,
    };
    let top = match metadata(path, &["rev-parse", "--show-toplevel"], deadline).await {
        Some((0, top)) => top,
        Some((128, _)) if !project.is_git && !path.join(".git").exists() => {
            member.metadata_complete = true;
            return member;
        }
        _ => return member,
    };
    let Ok(top) = std::str::from_utf8(&top) else {
        return member;
    };
    if top.len() > MAX_PATH_BYTES {
        return member;
    }
    let Ok(root) = canonicalize(Path::new(top.trim())) else {
        return member;
    };
    let Ok(relative) = real.strip_prefix(root) else {
        return member;
    };
    member.repository_relative_path = Some(relative.to_string_lossy().replace('\\', "/"));
    member.metadata_complete = true;
    if let Some(repository) = repository {
        member.repository_key = Some(opaque("repository", &[&repository.canonical]));
        member.repository_label = Some(repository.label);
    }
    member
}

fn group_key(member: &ProjectScopeCheckout) -> String {
    if member.grouping_mode != ProjectGroupingMode::Separate
        && let Some(repository) = &member.repository_key
    {
        let relative = if member.grouping_mode == ProjectGroupingMode::RepositoryPath {
            member.repository_relative_path.as_deref().unwrap_or("")
        } else {
            ""
        };
        return opaque("group", &["repository", repository, relative]);
    }
    opaque("group", &["physical", &member.physical_key])
}

/// A selected key must still name the same group/checkout. Unavailable targets
/// never become All projects, including when their folder disappeared.
pub fn resolve_project_settings_scope(
    groups: &[ProjectScopeGroup],
    selection: Option<&ProjectSettingsSelection>,
    metadata_complete: bool,
) -> ResolvedProjectSettingsScope {
    let unavailable = |reason| ResolvedProjectSettingsScope::Unavailable { reason };
    let Some(selection) = selection else {
        return ResolvedProjectSettingsScope::AllProjects;
    };
    let (key, project_id) = match selection {
        ProjectSettingsSelection::AllProjects {} => {
            return ResolvedProjectSettingsScope::AllProjects;
        }
        ProjectSettingsSelection::ProjectGroup { group_key } => (group_key, None),
        ProjectSettingsSelection::Checkout {
            group_key,
            project_id,
        } => (group_key, Some(project_id)),
    };
    let Some(group) = groups.iter().find(|group| &group.key == key) else {
        return unavailable(if metadata_complete {
            ProjectScopeUnavailableReason::ProjectMissing
        } else {
            ProjectScopeUnavailableReason::MetadataUnavailable
        });
    };
    if let Some(id) = project_id {
        let Some(member) = group.members.iter().find(|member| &member.project_id == id) else {
            return unavailable(ProjectScopeUnavailableReason::CheckoutMissing);
        };
        if let Some(reason) = member.unavailable {
            return unavailable(reason);
        }
        return ResolvedProjectSettingsScope::Checkout {
            group_key: key.clone(),
            project_id: id.clone(),
        };
    }
    if let Some(reason) = group.members.iter().find_map(|member| member.unavailable) {
        return unavailable(reason);
    }
    if !metadata_complete
        && group
            .members
            .iter()
            .any(|member| member.repository_key.is_some())
    {
        return unavailable(ProjectScopeUnavailableReason::MetadataUnavailable);
    }
    ResolvedProjectSettingsScope::ProjectGroup {
        group_key: key.clone(),
        project_ids: group
            .members
            .iter()
            .map(|member| member.project_id.clone())
            .collect(),
    }
}

impl Core {
    /// Read-only full-app catalog. Client grouping recipes do not edit project
    /// registration, preferences, remotes or any project file.
    pub async fn project_scope_catalog(
        &self,
        query: &ProjectScopesQuery,
    ) -> Result<ProjectScopeCatalog> {
        // Match the existing project sidebar: the harness library is not a
        // selectable project. Missing workspace state must not broaden targets.
        let library_root = self.workspace.root()?;
        let projects: Vec<_> = self
            .store
            .list_projects()?
            .into_iter()
            .filter(|project| Path::new(&project.path) != library_root)
            .collect();
        if projects.len() > MAX_PROJECTS || query.recipe.overrides.len() > MAX_PROJECTS {
            return Err(CoreError::Invalid("Too many local project scopes.".into()));
        }
        let known: BTreeSet<_> = projects.iter().map(|project| project.id.as_str()).collect();
        let mut overrides = BTreeMap::new();
        for entry in &query.recipe.overrides {
            if !known.contains(entry.project_id.as_str()) {
                return Err(CoreError::NotFound("project grouping override".into()));
            }
            if overrides
                .insert(entry.project_id.clone(), entry.mode)
                .is_some()
            {
                return Err(CoreError::Invalid(
                    "A project grouping override is repeated.".into(),
                ));
            }
        }
        let reader = tokio::time::timeout(CATALOG_BUDGET, self.workspace.library_reader())
            .await
            .ok();
        // A busy library prevents observing Git, not reading environment defaults.
        // Return physical targets with incomplete metadata rather than claim a
        // complete group or misclassify the contention as an app install.
        let deadline = Instant::now()
            + if reader.is_some() {
                CATALOG_BUDGET
            } else {
                Duration::ZERO
            };
        let members = stream::iter(projects)
            .map(|project| {
                let mode = overrides
                    .get(&project.id)
                    .copied()
                    .unwrap_or(query.recipe.mode);
                checkout(project, mode, deadline)
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        let mut grouped: BTreeMap<String, Vec<ProjectScopeCheckout>> = BTreeMap::new();
        for member in members {
            grouped.entry(group_key(&member)).or_default().push(member);
        }
        let mut groups = Vec::new();
        for (key, mut members) in grouped {
            members.sort_by(|a, b| a.project_id.cmp(&b.project_id));
            let names: BTreeSet<_> = members.iter().map(|member| member.name.as_str()).collect();
            let first = &members[0];
            let repository_label = first.repository_label.as_deref();
            let shared_custom_name = names.len() == 1
                && repository_label.is_none_or(|label| {
                    first.name != label && Some(first.name.as_str()) != label.rsplit('/').next()
                });
            let label = if shared_custom_name {
                first.name.clone()
            } else {
                first
                    .repository_label
                    .as_ref()
                    .unwrap_or(&first.name)
                    .clone()
            };
            groups.push(ProjectScopeGroup {
                key,
                label,
                members,
            });
        }
        let metadata_complete = groups
            .iter()
            .flat_map(|group| &group.members)
            .all(|member| member.metadata_complete);
        let membership: Vec<_> = groups
            .iter()
            .map(|group| {
                (
                    &group.key,
                    group
                        .members
                        .iter()
                        .map(|member| {
                            (
                                &member.project_id,
                                &member.physical_key,
                                member.grouping_mode,
                                member.unavailable,
                                member.metadata_complete,
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&(query.recipe.mode, overrides, membership))?;
        let version = opaque("catalog", &[&sha256_hex(&bytes)]);
        let selection =
            resolve_project_settings_scope(&groups, query.selection.as_ref(), metadata_complete);
        Ok(ProjectScopeCatalog {
            version,
            groups,
            metadata_complete,
            selection,
        })
    }
}

#[cfg(test)]
mod tests;
