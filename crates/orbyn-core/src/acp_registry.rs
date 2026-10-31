//! The public ACP registry: finding agents and installing one as a custom engine,
//! with no account and no credential. Agents sign in through their own commands. Reading
//! the registry and installing happen only when asked. The registry is someone else's
//! file, so an entry that does not parse is left out, names that reach a path are
//! checked, and a binary runs only if its archive matches the digest the entry gives.
//! An `npx` or `uvx` agent installs nothing here: the tool fetches it on first run.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use orbyn_contracts::{AcpRegistryEntry, CustomEngine, EngineStatus, EngineTier};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::process::resolve;
use crate::store::AuditRecord;
use crate::util::new_id;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(15);
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ENTRIES: usize = 200;
const MAX_ARGS: usize = 64;
const AGENTS_DIR: &str = "acp-agents";

#[derive(Clone, Debug, Default, Deserialize)]
struct Registry {
    #[serde(default)]
    agents: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
struct Agent {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    distribution: Distribution,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct Distribution {
    #[serde(default)]
    binary: std::collections::BTreeMap<String, BinaryTarget>,
    npx: Option<Package>,
    uvx: Option<Package>,
}

#[derive(Clone, Debug, Deserialize)]
struct BinaryTarget {
    archive: String,
    cmd: String,
    sha256: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Package {
    package: String,
    #[serde(default)]
    args: Vec<String>,
}

/// One folder name: nothing that could climb out of where it is put.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

/// A package name for `npx` or `uvx`, which must not read as one of their flags.
fn safe_package(package: &str) -> bool {
    !package.is_empty()
        && package.len() <= 214
        && !package.starts_with('-')
        && package
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@/._+-=<>~^[],".contains(&byte))
}

fn platform_key() -> Option<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

/// Only entries that parse and whose names are safe. One bad entry costs itself.
fn parse_agents(registry: Registry) -> Vec<Agent> {
    registry
        .agents
        .into_iter()
        .take(MAX_ENTRIES * 4)
        .filter_map(|agent| serde_json::from_value::<Agent>(agent).ok())
        .filter(|agent| safe_name(&agent.id) && safe_name(&agent.version))
        .collect()
}

/// What this machine can install an agent through, best first. A binary with no digest
/// cannot be checked, so it does not count.
fn installable(agent: &Agent) -> Vec<&'static str> {
    let mut found = Vec::new();
    let binary = platform_key().and_then(|key| agent.distribution.binary.get(&key).cloned());
    if binary.is_some_and(|target| target.sha256.is_some()) {
        found.push("binary");
    }
    if agent.distribution.npx.is_some() && resolve("npx").is_some() {
        found.push("npx");
    }
    if agent.distribution.uvx.is_some() && resolve("uvx").is_some() {
        found.push("uvx");
    }
    found
}

fn engine_id(agent: &str) -> String {
    format!("acp-{agent}")
}

/// `https`, or plain `http` to this machine, which only a test or a local mirror uses.
fn fetchable(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    match parsed.scheme() {
        "https" => true,
        "http" => matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")),
        _ => false,
    }
}

/// A relative command inside the install folder.
fn command_path(root: &Path, cmd: &str) -> Result<PathBuf> {
    let refused = || CoreError::Unsupported("That agent's command is not inside its files.".into());
    let relative = Path::new(cmd);
    let plain = relative
        .components()
        .all(|part| matches!(part, Component::Normal(_) | Component::CurDir));
    if !plain {
        return Err(refused());
    }
    let full = crate::util::canonicalize(&root.join(relative)).map_err(|_| refused())?;
    let base = crate::util::canonicalize(root)?;
    if !full.starts_with(&base) || !full.is_file() {
        return Err(refused());
    }
    Ok(full)
}

/// Fails if anything extracted is a link leading out, so a bad archive cannot aim the
/// install at another file.
fn check_tree(root: &Path) -> Result<()> {
    let base = crate::util::canonicalize(root)?;
    let mut folders = vec![base.clone()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                let target = crate::util::canonicalize(&entry.path());
                if !target.is_ok_and(|target| target.starts_with(&base)) {
                    return Err(CoreError::Unsupported(
                        "That archive holds a link out of its own folder.".into(),
                    ));
                }
            } else if kind.is_dir() {
                folders.push(entry.path());
            }
        }
    }
    Ok(())
}

/// `tar` reads every form on macOS and Windows, and refuses `..` in names by default.
/// GNU `tar` has no zip, so Linux uses `unzip` for those.
async fn extract(archive: &Path, name: &str, into: &Path) -> Result<()> {
    let lower = name.to_ascii_lowercase();
    let zip = lower.ends_with(".zip");
    let packed = zip
        || [".tar.gz", ".tgz", ".tar.bz2", ".tbz2"]
            .iter()
            .any(|end| lower.ends_with(end));
    if !packed {
        let target = into.join(name);
        std::fs::rename(archive, target)?;
        return Ok(());
    }
    let mut command = if zip && cfg!(target_os = "linux") {
        let mut unzip = Command::new("unzip");
        unzip.arg("-q").arg(archive).arg("-d").arg(into);
        unzip
    } else {
        let mut tar = Command::new("tar");
        tar.arg("-xf").arg(archive).arg("-C").arg(into);
        tar
    };
    crate::child_env::for_tool(command.as_std_mut());
    command.kill_on_drop(true);
    let run = command.output();
    let finished = tokio::time::timeout(EXTRACT_TIMEOUT, run)
        .await
        .map_err(|_| {
            CoreError::EngineUnavailable("Unpacking that agent took too long.".into())
        })??;
    if !finished.status.success() {
        return Err(CoreError::EngineUnavailable(
            "That agent's archive could not be unpacked.".into(),
        ));
    }
    let _ = std::fs::remove_file(archive);
    Ok(())
}

fn make_runnable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

impl Core {
    async fn registry_agents(&self) -> Result<Vec<Agent>> {
        let url = &self.config.acp_registry_url;
        if !fetchable(url) {
            return Err(CoreError::Invalid(
                "The ACP registry URL is not usable.".into(),
            ));
        }
        let unreachable =
            || CoreError::EngineUnavailable("The ACP registry could not be reached.".into());
        let response = self
            .http
            .get(url)
            .timeout(REGISTRY_TIMEOUT)
            .send()
            .await
            .map_err(|_| unreachable())?;
        if !response.status().is_success() {
            return Err(unreachable());
        }
        let mut body = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            body.extend_from_slice(&chunk.map_err(|_| unreachable())?);
            if body.len() > MAX_REGISTRY_BYTES {
                return Err(CoreError::EngineUnavailable(
                    "The ACP registry answered with too much.".into(),
                ));
            }
        }
        let registry = serde_json::from_slice(&body).map_err(|_| {
            CoreError::EngineUnavailable("The ACP registry sent something unreadable.".into())
        })?;
        Ok(parse_agents(registry))
    }

    /// Agents matching every word of `query`, by name, id or description.
    pub async fn search_acp_registry(&self, query: &str) -> Result<Vec<AcpRegistryEntry>> {
        let engines = self.store.list_custom_engines()?;
        Ok(self
            .registry_agents()
            .await?
            .into_iter()
            .filter(|agent| {
                query.trim().is_empty()
                    || crate::mcp_tools::matches_words(
                        &format!("{} {} {}", agent.name, agent.id, agent.description),
                        query,
                    )
            })
            .take(MAX_ENTRIES)
            .map(|agent| {
                let engine = engine_id(&agent.id);
                AcpRegistryEntry {
                    installable: installable(&agent).into_iter().map(str::to_owned).collect(),
                    engine: engines
                        .iter()
                        .any(|known| known.id == engine)
                        .then_some(engine),
                    id: agent.id,
                    name: agent.name,
                    version: agent.version,
                    description: agent.description,
                }
            })
            .collect())
    }

    async fn fetch_archive(&self, url: &str, to: &Path, digest: &str) -> Result<()> {
        if !fetchable(url) {
            return Err(CoreError::Unsupported(
                "That agent's archive is not on https.".into(),
            ));
        }
        let failed =
            || CoreError::EngineUnavailable("That agent's archive could not be downloaded.".into());
        let response = self
            .http
            .get(url)
            .timeout(ARCHIVE_TIMEOUT)
            .send()
            .await
            .map_err(|_| failed())?;
        if !response.status().is_success() {
            return Err(failed());
        }
        let mut file = tokio::fs::File::create(to).await?;
        let (mut hasher, mut size) = (Sha256::new(), 0u64);
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|_| failed())?;
            size += chunk.len() as u64;
            if size > MAX_ARCHIVE_BYTES {
                return Err(CoreError::Unsupported(
                    "That agent's archive is too large.".into(),
                ));
            }
            hasher.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
        }
        tokio::io::AsyncWriteExt::flush(&mut file).await?;
        if !crate::util::hex(&hasher.finalize()).eq_ignore_ascii_case(digest) {
            return Err(CoreError::Unsupported(
                "That agent's archive does not match its digest, so it was not installed.".into(),
            ));
        }
        Ok(())
    }

    /// Downloads, checks and unpacks into a staging folder, which becomes the install
    /// only once everything passed. Returns the command and its arguments.
    async fn install_binary(&self, agent: &Agent) -> Result<(String, Vec<String>)> {
        let target = platform_key()
            .and_then(|key| agent.distribution.binary.get(&key))
            .ok_or_else(|| CoreError::Unsupported("No build for this machine.".into()))?;
        let digest = target.sha256.as_deref().ok_or_else(|| {
            CoreError::Unsupported("That build gives no digest, so it cannot be checked.".into())
        })?;
        let parent = self.config.data_dir.join(AGENTS_DIR).join(&agent.id);
        std::fs::create_dir_all(&parent)?;
        let staging = parent.join(format!(".staging-{}", new_id()));
        std::fs::create_dir_all(&staging)?;
        let done = self.unpack(target, digest, &staging).await;
        let installed = done.and_then(|()| {
            let final_dir = parent.join(&agent.version);
            if final_dir.exists() {
                std::fs::remove_dir_all(&final_dir)?;
            }
            std::fs::rename(&staging, &final_dir)?;
            let command = command_path(&final_dir, &target.cmd)?;
            make_runnable(&command)?;
            Ok(command.to_string_lossy().into_owned())
        });
        match installed {
            Ok(command) => Ok((command, target.args.clone())),
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                Err(error)
            }
        }
    }

    async fn unpack(&self, target: &BinaryTarget, digest: &str, staging: &Path) -> Result<()> {
        let name = reqwest::Url::parse(&target.archive)
            .ok()
            .and_then(|url| url.path_segments()?.next_back().map(str::to_owned))
            .filter(|name| safe_name(name))
            .unwrap_or_else(|| "agent.bin".to_owned());
        // Outside the staging folder's tree, so `check_tree` sees only what it unpacked.
        let archive = staging.with_extension(format!("{}.download", new_id()));
        let fetched = self.fetch_archive(&target.archive, &archive, digest).await;
        let unpacked = match fetched {
            Ok(()) => extract(&archive, &name, staging).await,
            Err(error) => Err(error),
        };
        let _ = std::fs::remove_file(&archive);
        unpacked?;
        check_tree(staging)?;
        command_path(staging, &target.cmd).map(|_| ())
    }

    /// Makes a registry agent a custom engine. It starts with no credential: an agent
    /// that needs a login says so when run, and that login stays its own.
    pub async fn install_acp_agent(
        &self,
        id: &str,
        distribution: Option<&str>,
        actor: &str,
    ) -> Result<EngineStatus> {
        let agent = self
            .registry_agents()
            .await?
            .into_iter()
            .find(|agent| agent.id == id)
            .ok_or_else(|| CoreError::NotFound("agent".into()))?;
        let usable = installable(&agent);
        let chosen = match distribution {
            Some(wanted) => usable.iter().copied().find(|kind| *kind == wanted),
            None => usable.first().copied(),
        }
        .ok_or_else(|| {
            CoreError::Unsupported("This machine cannot install that agent that way.".into())
        })?;
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "acp.install".into(),
            target: agent.id.clone(),
            decision: None,
            source: "user".into(),
            thread_id: None,
            run_id: None,
            detail: serde_json::json!({ "version": agent.version, "distribution": chosen }),
        })?;
        let (target, args) = match chosen {
            "binary" => self.install_binary(&agent).await?,
            tool => {
                let package = if tool == "npx" {
                    agent.distribution.npx.as_ref()
                } else {
                    agent.distribution.uvx.as_ref()
                }
                .ok_or_else(|| CoreError::Internal("A listed package vanished.".into()))?;
                if !safe_package(&package.package) {
                    return Err(CoreError::Unsupported(
                        "That agent's package name is not usable.".into(),
                    ));
                }
                let mut args = if tool == "npx" {
                    vec!["-y".to_owned()]
                } else {
                    Vec::new()
                };
                args.push(package.package.clone());
                args.extend(package.args.iter().cloned());
                (tool.to_owned(), args)
            }
        };
        if args.len() > MAX_ARGS {
            return Err(CoreError::Unsupported(
                "That agent has too many arguments.".into(),
            ));
        }
        let engine = CustomEngine {
            id: engine_id(&agent.id),
            name: agent.name,
            tier: EngineTier::Acp,
            target,
            args,
        };
        self.store.save_custom_engine(&engine, actor)?;
        self.engines.invalidate().await;
        self.engines.status(&engine.id).await
    }

    /// Removes the engine and any files it installed. Threads keep their history.
    pub async fn remove_acp_agent(&self, id: &str, actor: &str) -> Result<()> {
        if !safe_name(id) {
            return Err(CoreError::NotFound("agent".into()));
        }
        let engine = engine_id(id);
        if !self
            .store
            .list_custom_engines()?
            .iter()
            .any(|known| known.id == engine)
        {
            return Err(CoreError::NotFound("agent".into()));
        }
        if self.store.active_runs_for_engine(&engine)? > 0 {
            return Err(CoreError::EngineBusy(engine));
        }
        self.store.delete_custom_engine(&engine, actor)?;
        self.engines.invalidate().await;
        let files = self.config.data_dir.join(AGENTS_DIR).join(id);
        match std::fs::remove_dir_all(files) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_that_reach_a_path_are_checked() {
        for bad in ["", ".", "..", "a/b", "a\\b", "../x", "a b", &"x".repeat(65)] {
            assert!(!safe_name(bad), "{bad}");
        }
        assert!(safe_name("agent-1.2.3+build"));
        for bad in ["-rf", "--registry=evil", "a b", "a;b", "$(x)"] {
            assert!(!safe_package(bad), "{bad}");
        }
        assert!(safe_package("@scope/agent@1.2.3"));
        assert!(safe_package("agent==1.2"));
    }

    #[test]
    fn a_bad_entry_costs_only_itself() {
        let registry = Registry {
            agents: vec![
                json!({ "id": "good", "name": "Good", "version": "1.0" }),
                json!({ "id": "no-name" }),
                json!({ "id": "../up", "name": "Up", "version": "1.0" }),
                json!({ "id": "bad-version", "name": "V", "version": "../../x" }),
                json!("nonsense"),
            ],
        };
        let agents = parse_agents(registry);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "good");
    }

    #[test]
    fn only_https_or_this_machine_is_fetched() {
        assert!(fetchable("https://example.com/a.tgz"));
        assert!(fetchable("http://127.0.0.1:9/a.tgz"));
        for bad in [
            "http://example.com/a",
            "file:///etc/passwd",
            "ftp://x/y",
            "nonsense",
        ] {
            assert!(!fetchable(bad), "{bad}");
        }
    }

    #[test]
    fn a_binary_without_a_digest_cannot_be_installed() {
        let key = platform_key().unwrap();
        let agent: Agent = serde_json::from_value(json!({
            "id": "a", "name": "A", "version": "1",
            "distribution": { "binary": { key: { "archive": "https://x/a.tgz", "cmd": "a" } } },
        }))
        .unwrap();
        assert!(!installable(&agent).contains(&"binary"));
    }

    #[test]
    fn a_command_stays_inside_its_folder() {
        let dir = crate::testing::TempDir::new();
        std::fs::write(dir.path().join("agent"), "x").unwrap();
        assert!(command_path(dir.path(), "./agent").is_ok());
        for bad in ["../agent", "/bin/sh", "missing", "."] {
            assert!(command_path(dir.path(), bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_an_archive_is_refused() {
        let dir = crate::testing::TempDir::new();
        std::os::unix::fs::symlink("/etc/hosts", dir.path().join("agent")).unwrap();
        assert!(check_tree(dir.path()).is_err());
        assert!(command_path(dir.path(), "agent").is_err());
    }
}
