//! Skill packs: built from the source library into app data, never into a
//! repository, then signed. Every use re-verifies the files against the signed
//! manifest, so a changed pack is refused rather than delivered.
//!
//! The signing key lives next to the pack, so this detects tampering by anything
//! that cannot read the key, such as a sync tool, a stray edit or a build
//! mistake. It does not stop a process running as the same user.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use orbyn_contracts::{SkillDelivery, SkillPackStatus, SkillProfile, SkillSummary};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::driver::SkillPlan;
use crate::error::{CoreError, Result};
use crate::store::Store;
use crate::util::{from_hex, hex, new_id, random_bytes, sha256_hex, write_private};

pub const DEFAULT_PROFILE: &str = "default";
const PLUGIN_NAME: &str = "orbyn-skills";
const BOOTSTRAP_LIMIT: usize = 8 * 1024;
/// License and provenance files that must travel with the content.
const NOTICE_FILES: &[&str] = &["LICENSE", "NOTICE", "provenance.json"];
const IGNORED_FILES: &[&str] = &[".DS_Store", "Thumbs.db"];
const IGNORED_DIRS: &[&str] = &["__pycache__", "node_modules", ".git"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PackSkill {
    pub name: String,
    pub category: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PackFile {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PackManifest {
    pub schema: u32,
    pub version: String,
    pub digest: String,
    pub built_at: String,
    pub source: Option<String>,
    pub skills: Vec<PackSkill>,
    pub notices: Vec<String>,
    pub files: Vec<PackFile>,
}

#[derive(Serialize, Deserialize)]
struct CurrentPointer {
    dir: String,
}

#[derive(Debug)]
struct LoadedPack {
    dir: PathBuf,
    manifest: PackManifest,
}

pub struct SkillService {
    store: Arc<Store>,
    root: PathBuf,
    source: Option<PathBuf>,
    current: RwLock<Option<Arc<LoadedPack>>>,
}

impl SkillService {
    pub fn new(store: Arc<Store>, data_dir: &Path, source: Option<PathBuf>) -> Self {
        Self {
            store,
            root: data_dir.join("skills"),
            source,
            current: RwLock::new(None),
        }
    }

    pub fn source(&self) -> Option<&Path> {
        self.source.as_deref()
    }

    fn key_path(&self) -> PathBuf {
        self.root.join("keys").join("pack-signing.key")
    }

    fn pointer_path(&self) -> PathBuf {
        self.root.join("current.json")
    }

    /// Loads the installed pack, building one from the source if none exists.
    /// A pack that fails verification stays unloaded and reports invalid.
    pub fn startup(&self) -> Result<()> {
        if self.pointer_path().exists() {
            if let Err(error) = self.load_current() {
                tracing::error!(%error, "installed skill pack failed verification");
            }
            return Ok(());
        }
        if self.source.is_some() {
            self.rebuild()?;
        }
        Ok(())
    }

    fn signing_key(&self) -> Result<SigningKey> {
        let path = self.key_path();
        if let Ok(text) = std::fs::read_to_string(&path) {
            let bytes: [u8; 32] = from_hex(text.trim())
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| CoreError::PackTampered("the signing key is unreadable".into()))?;
            return Ok(SigningKey::from_bytes(&bytes));
        }
        let bytes = random_bytes::<32>()?;
        write_private(&path, hex(&bytes).as_bytes())?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    /// Builds a new pack and makes it current only after it verifies.
    pub fn rebuild(&self) -> Result<SkillPackStatus> {
        let source = self
            .source
            .as_deref()
            .ok_or_else(|| CoreError::Invalid("No skill library was found.".into()))?;
        let key = self.signing_key()?;
        let packs = self.root.join("packs");
        let staging = packs.join(format!(".staging-{}", new_id()));
        let built = build_pack(source, &staging, &key);
        let manifest = match built {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        let dir = packs.join(&manifest.digest[..16]);
        if dir.exists() {
            std::fs::remove_dir_all(&staging)?;
            // Same content: the existing pack is reused only if it still verifies.
            if verify_pack(&dir, &key).is_err() {
                std::fs::remove_dir_all(&dir)?;
                return self.rebuild();
            }
        } else {
            std::fs::rename(&staging, &dir)?;
        }
        let pointer = CurrentPointer {
            dir: dir.to_string_lossy().into_owned(),
        };
        std::fs::write(self.pointer_path(), serde_json::to_vec(&pointer)?)?;
        self.load_current()?;
        self.status()
    }

    fn load_current(&self) -> Result<Arc<LoadedPack>> {
        let pointer: CurrentPointer = serde_json::from_slice(&std::fs::read(self.pointer_path())?)?;
        let dir = PathBuf::from(pointer.dir);
        let key = self.signing_key()?;
        let manifest = verify_pack(&dir, &key).inspect_err(|_| {
            *self.current.write().unwrap_or_else(|e| e.into_inner()) = None;
        })?;
        let pack = Arc::new(LoadedPack { dir, manifest });
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = Some(pack.clone());
        Ok(pack)
    }

    /// The pack, re-verified now. `Ok(None)` means none is installed.
    fn verified(&self) -> Result<Option<Arc<LoadedPack>>> {
        if !self.pointer_path().exists() {
            return Ok(None);
        }
        self.load_current().map(Some)
    }

    pub fn status(&self) -> Result<SkillPackStatus> {
        let source = self
            .source
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let verified = self.verified();
        let pack = match verified {
            Ok(Some(pack)) => pack,
            Ok(None) => {
                return Ok(SkillPackStatus {
                    version: String::new(),
                    digest: String::new(),
                    signature_valid: false,
                    source,
                    skills: Vec::new(),
                });
            }
            Err(error) => {
                tracing::warn!(%error, "skill pack status: verification failed");
                return Ok(SkillPackStatus {
                    version: String::new(),
                    digest: String::new(),
                    signature_valid: false,
                    source,
                    skills: Vec::new(),
                });
            }
        };
        let enabled = default_selection(&pack.manifest.skills);
        Ok(SkillPackStatus {
            version: pack.manifest.version.clone(),
            digest: pack.manifest.digest.clone(),
            signature_valid: true,
            source,
            skills: pack
                .manifest
                .skills
                .iter()
                .map(|skill| SkillSummary {
                    name: skill.name.clone(),
                    category: skill.category.clone(),
                    description: skill.description.clone(),
                    enabled: enabled.contains(&skill.name),
                })
                .collect(),
        })
    }

    /// The default profile first, then stored ones.
    pub fn profiles(&self) -> Result<Vec<SkillProfile>> {
        let mut profiles = vec![SkillProfile {
            id: DEFAULT_PROFILE.into(),
            name: "Default".into(),
            skills: self.default_skills()?,
        }];
        profiles.extend(self.store.list_profiles()?);
        Ok(profiles)
    }

    fn default_skills(&self) -> Result<Vec<String>> {
        Ok(match self.verified() {
            Ok(Some(pack)) => default_selection(&pack.manifest.skills)
                .into_iter()
                .collect(),
            _ => Vec::new(),
        })
    }

    fn selection(&self, profile: Option<&str>) -> Result<Vec<String>> {
        match profile {
            None | Some(DEFAULT_PROFILE) => self.default_skills(),
            Some(id) => self
                .store
                .profile(id)?
                .map(|profile| profile.skills)
                .ok_or_else(|| CoreError::NotFound("skill profile".into())),
        }
    }

    /// Chooses delivery for one run from the driver's declared support, taking
    /// the first match in product order, and returns the profile's skill names.
    pub fn plan(
        &self,
        supported: &[SkillDelivery],
        profile: Option<&str>,
    ) -> Result<(SkillPlan, Vec<String>)> {
        let Some(pack) = self.verified()? else {
            return Ok((SkillPlan::default(), Vec::new()));
        };
        let selection = self.selection(profile)?;
        let delivery = choose_delivery(supported);
        let mut plan = SkillPlan::default();
        match delivery {
            Some(SkillDelivery::NativePlugin) => {
                let view = materialize(&pack, &selection)?;
                plan.plugin_dir = Some(view.join("claude-plugin"));
            }
            Some(SkillDelivery::NativeSkillRoot) => {
                let view = materialize(&pack, &selection)?;
                plan.skill_root = Some(view.join("skills"));
            }
            Some(SkillDelivery::PromptBootstrap) => {
                plan.bootstrap = Some(bootstrap_text(&pack.manifest, &selection));
            }
            Some(SkillDelivery::McpSkillServer) | None => {}
        }
        Ok((plan, selection))
    }

    /// Matches names and descriptions in the allowed selection.
    pub fn search(&self, query: &str, allowed: &[String]) -> Result<Vec<Value>> {
        let Some(pack) = self.verified()? else {
            return Ok(Vec::new());
        };
        let terms: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        Ok(pack
            .manifest
            .skills
            .iter()
            .filter(|skill| allowed.contains(&skill.name))
            .filter(|skill| {
                let text = format!("{} {}", skill.name, skill.description).to_lowercase();
                terms.iter().all(|term| text.contains(term))
            })
            .map(|skill| json!({ "name": skill.name, "description": skill.description }))
            .collect())
    }

    /// Reads a skill file from the verified pack. Only files the signed manifest
    /// lists can be returned, so a path cannot escape the pack.
    pub fn load(&self, name: &str, file: Option<&str>, allowed: &[String]) -> Result<String> {
        if !allowed.iter().any(|skill| skill == name) {
            return Err(CoreError::NotFound(format!("skill {name}")));
        }
        let pack = self
            .verified()?
            .ok_or_else(|| CoreError::NotFound(format!("skill {name}")))?;
        let relative = format!("skills/{name}/{}", file.unwrap_or("SKILL.md"));
        if !pack
            .manifest
            .files
            .iter()
            .any(|entry| entry.path == relative)
        {
            return Err(CoreError::NotFound(format!("skill file {relative}")));
        }
        Ok(std::fs::read_to_string(pack.dir.join(&relative))?)
    }
}

/// Excludes REA and social skills, which are specialist choices.
pub fn default_selection(skills: &[PackSkill]) -> BTreeSet<String> {
    skills
        .iter()
        .filter(|skill| {
            let category = skill.category.to_lowercase();
            !(category.contains("rea") && category.contains("maintenance"))
                && !category.contains("social")
                && !skill.name.starts_with("rea-")
                && !skill.name.starts_with("social-")
        })
        .map(|skill| skill.name.clone())
        .collect()
}

/// Core's ladder: the first supported rung wins.
pub fn choose_delivery(supported: &[SkillDelivery]) -> Option<SkillDelivery> {
    [
        SkillDelivery::NativePlugin,
        SkillDelivery::NativeSkillRoot,
        SkillDelivery::McpSkillServer,
        SkillDelivery::PromptBootstrap,
    ]
    .into_iter()
    .find(|rung| supported.contains(rung))
}

fn bootstrap_text(manifest: &PackManifest, selection: &[String]) -> String {
    let mut text = String::from(
        "Orbyn engineering skills apply to this task. Follow the matching skill's method:\n",
    );
    for skill in &manifest.skills {
        if selection.contains(&skill.name) {
            let line = format!("- {}: {}\n", skill.name, skill.description);
            if text.len() + line.len() > BOOTSTRAP_LIMIT {
                break;
            }
            text.push_str(&line);
        }
    }
    text
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Reads `name` and `description` from the leading `---` block of a SKILL.md.
pub fn parse_frontmatter(text: &str) -> Option<(String, String)> {
    let body = text.strip_prefix("---")?;
    let end = body.find("\n---")?;
    let mut name = None;
    let mut description = None;
    for line in body[..end].lines() {
        if let Some((key, value)) = line.split_once(':') {
            let value = unquote(value.trim());
            match key.trim() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }
    Some((name?, description.unwrap_or_default()))
}

fn unquote(value: &str) -> String {
    let inner = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'));
    match inner {
        Some(inner) => inner.replace("\\\"", "\""),
        None => value.to_owned(),
    }
}

#[derive(Deserialize)]
struct Catalog {
    skills: Vec<CatalogSkill>,
}

#[derive(Deserialize)]
struct CatalogSkill {
    name: String,
    category: String,
}

fn build_pack(source: &Path, staging: &Path, key: &SigningKey) -> Result<PackManifest> {
    let catalog: Catalog = serde_json::from_slice(&std::fs::read(source.join("catalog.json"))?)?;
    let mut skills = Vec::new();
    for entry in catalog.skills {
        if !safe_name(&entry.name) {
            return Err(CoreError::Invalid(format!(
                "Skill name {:?} is not valid.",
                entry.name
            )));
        }
        let dir = source.join(&entry.name);
        let text = std::fs::read_to_string(dir.join("SKILL.md"))
            .map_err(|_| CoreError::Invalid(format!("Skill {} has no SKILL.md.", entry.name)))?;
        let (name, description) = parse_frontmatter(&text).ok_or_else(|| {
            CoreError::Invalid(format!("Skill {} has no frontmatter.", entry.name))
        })?;
        if name != entry.name {
            return Err(CoreError::Invalid(format!(
                "Skill folder {} declares the name {name}.",
                entry.name
            )));
        }
        copy_tree(&dir, &staging.join("skills").join(&name))?;
        copy_tree(&dir, &staging.join("claude-plugin/skills").join(&name))?;
        skills.push(PackSkill {
            name,
            category: entry.category,
            description,
        });
    }
    let mut notices = Vec::new();
    let library = source.parent().unwrap_or(source);
    for notice in NOTICE_FILES {
        let from = library.join(notice);
        if from.is_file() {
            for root in ["skills", "claude-plugin"] {
                std::fs::copy(&from, staging.join(root).join(notice))?;
            }
            notices.push((*notice).to_owned());
        }
    }

    let mut files = BTreeMap::new();
    hash_tree(staging, staging, &mut files)?;
    let digest = sha256_hex(
        files
            .iter()
            .map(|(path, sha)| format!("{path}\0{sha}\n"))
            .collect::<String>()
            .as_bytes(),
    );
    let version = format!("1.{}", &digest[..12]);
    let plugin = json!({
        "name": PLUGIN_NAME,
        "version": version,
        "description": "Orbyn engineering skills",
    });
    let plugin_path = staging.join("claude-plugin/.claude-plugin/plugin.json");
    std::fs::create_dir_all(plugin_path.parent().unwrap_or(staging))?;
    std::fs::write(&plugin_path, serde_json::to_vec_pretty(&plugin)?)?;
    files.clear();
    hash_tree(staging, staging, &mut files)?;

    let manifest = PackManifest {
        schema: 1,
        version,
        digest,
        built_at: crate::util::now(),
        source: Some(source.to_string_lossy().into_owned()),
        skills,
        notices,
        files: files
            .into_iter()
            .map(|(path, sha256)| PackFile { path, sha256 })
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    std::fs::write(staging.join("manifest.json"), &bytes)?;
    std::fs::write(
        staging.join("manifest.sig"),
        hex(&key.sign(&bytes).to_bytes()),
    )?;
    Ok(manifest)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        // Symlinks are skipped: following one could pull in files outside the skill.
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if !IGNORED_DIRS.contains(&name_text.as_ref()) {
                copy_tree(&entry.path(), &to.join(&name))?;
            }
        } else if kind.is_file() && !IGNORED_FILES.contains(&name_text.as_ref()) {
            std::fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

fn hash_tree(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            hash_tree(root, &path, files)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| CoreError::Internal(error.to_string()))?;
            let name = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            // A symlink hashes through its target but cannot equal a listed
            // regular file's entry path unless it replaced one; reject it.
            if !kind.is_file() {
                return Err(CoreError::PackTampered(format!("{name} is not a file")));
            }
            files.insert(name, sha256_hex(&std::fs::read(&path)?));
        }
    }
    Ok(())
}

/// Checks the signature, then every file, and that nothing was added.
fn verify_pack(dir: &Path, key: &SigningKey) -> Result<PackManifest> {
    let tampered = |what: &str| CoreError::PackTampered(what.to_owned());
    let bytes = std::fs::read(dir.join("manifest.json")).map_err(|_| tampered("no manifest"))?;
    let signature =
        std::fs::read_to_string(dir.join("manifest.sig")).map_err(|_| tampered("no signature"))?;
    let signature: [u8; 64] = from_hex(signature.trim())
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| tampered("malformed signature"))?;
    key.verifying_key()
        .verify(&bytes, &Signature::from_bytes(&signature))
        .map_err(|_| tampered("bad signature"))?;
    let manifest: PackManifest = serde_json::from_slice(&bytes)?;
    let mut actual = BTreeMap::new();
    for root in ["skills", "claude-plugin"] {
        hash_tree(dir, &dir.join(root), &mut actual)?;
    }
    check_files(&manifest.files, &actual)?;
    Ok(manifest)
}

fn check_files(expected: &[PackFile], actual: &BTreeMap<String, String>) -> Result<()> {
    if expected.len() != actual.len() {
        return Err(CoreError::PackTampered("the file set changed".into()));
    }
    for entry in expected {
        if actual.get(&entry.path) != Some(&entry.sha256) {
            return Err(CoreError::PackTampered(format!("{} changed", entry.path)));
        }
    }
    Ok(())
}

/// Builds the view of a pack holding only the selected skills, once per
/// selection. Paths mirror the manifest, so the view is verifiable too.
fn materialize(pack: &LoadedPack, selection: &[String]) -> Result<PathBuf> {
    let mut names: Vec<&str> = selection.iter().map(String::as_str).collect();
    names.sort_unstable();
    let id = sha256_hex(names.join("\n").as_bytes());
    let view = pack.dir.join("profiles").join(&id[..16]);
    let selected: BTreeSet<&str> = names.iter().copied().collect();
    let wanted: Vec<&PackFile> = pack
        .manifest
        .files
        .iter()
        .filter(|file| belongs(&file.path, &selected))
        .collect();
    if view.exists() {
        let mut actual = BTreeMap::new();
        for root in ["skills", "claude-plugin"] {
            hash_tree(&view, &view.join(root), &mut actual)?;
        }
        let expected: Vec<PackFile> = wanted.iter().map(|file| (*file).clone()).collect();
        check_files(&expected, &actual)?;
        return Ok(view);
    }
    let staging = pack
        .dir
        .join("profiles")
        .join(format!(".staging-{}", new_id()));
    for file in &wanted {
        let relative = safe_relative(&file.path)?;
        let target = staging.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(pack.dir.join(&relative), target)?;
    }
    for root in ["skills", "claude-plugin"] {
        std::fs::create_dir_all(staging.join(root))?;
    }
    if std::fs::rename(&staging, &view).is_err() {
        // A concurrent run built the same view first.
        std::fs::remove_dir_all(&staging)?;
    }
    Ok(view)
}

fn belongs(path: &str, selected: &BTreeSet<&str>) -> bool {
    let inner = path
        .strip_prefix("claude-plugin/skills/")
        .or_else(|| path.strip_prefix("skills/"));
    match inner.map(|rest| rest.split_once('/')) {
        Some(Some((skill, _))) => selected.contains(skill),
        // Notices at each root and the plugin manifest always travel.
        _ => true,
    }
}

fn safe_relative(path: &str) -> Result<PathBuf> {
    let relative = PathBuf::from(path);
    if relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        Ok(relative)
    } else {
        Err(CoreError::PackTampered(format!("{path} is not relative")))
    }
}

/// Finds the outer library by walking up from the working directory and binary.
pub fn detect_source() -> Option<PathBuf> {
    let starts = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf)),
    ];
    starts.into_iter().flatten().find_map(|start| {
        start
            .ancestors()
            .map(|dir| dir.join("skills"))
            .find(|skills| skills.join("catalog.json").is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn library(root: &Path) -> PathBuf {
        let source = root.join("library/skills");
        write(
            &source.join("catalog.json"),
            r#"{"schema_version":1,"categories":[],"skills":[
                {"name":"how","category":"Engineering practice","related":[]},
                {"name":"rea-tool-design","category":"Artifact investigation and REA maintenance","related":[]},
                {"name":"reverse-engineer-anything","category":"Artifact investigation and REA maintenance","related":[]},
                {"name":"social-content","category":"Social content and visuals","related":[]}
            ],"retired_skills":[]}"#,
        );
        for name in [
            "how",
            "rea-tool-design",
            "reverse-engineer-anything",
            "social-content",
        ] {
            write(
                &source.join(name).join("SKILL.md"),
                &format!(
                    "---\nname: {name}\ndescription: \"Does {name}: well\"\n---\n\n# {name}\n"
                ),
            );
            write(&source.join(name).join("LICENSE"), "skill license");
            write(&source.join(name).join("references/a.md"), "reference");
        }
        write(&root.join("library/LICENSE"), "root license");
        write(&root.join("library/provenance.json"), "{}");
        source
    }

    struct Fixture {
        dir: TempDir,
        service: SkillService,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new();
        let source = library(dir.path());
        let data = dir.path().join("data");
        let store = Arc::new(Store::open(&data.join("db"), "e").unwrap());
        let service = SkillService::new(store, &data, Some(source));
        service.startup().unwrap();
        Fixture { dir, service }
    }

    fn current_dir(service: &SkillService) -> PathBuf {
        let pointer: CurrentPointer =
            serde_json::from_slice(&std::fs::read(service.pointer_path()).unwrap()).unwrap();
        PathBuf::from(pointer.dir)
    }

    #[test]
    fn frontmatter_reads_quoted_values_with_colons() {
        assert_eq!(
            parse_frontmatter("---\nname: a\ndescription: \"b: c\"\n---\nbody"),
            Some(("a".into(), "b: c".into()))
        );
        assert_eq!(parse_frontmatter("no frontmatter"), None);
    }

    #[test]
    fn build_signs_and_keeps_notices_with_each_root() {
        let f = fixture();
        let status = f.service.status().unwrap();
        assert!(status.signature_valid);
        assert_eq!(status.skills.len(), 4);
        let dir = current_dir(&f.service);
        for path in [
            "manifest.sig",
            "claude-plugin/.claude-plugin/plugin.json",
            "claude-plugin/skills/how/SKILL.md",
            "claude-plugin/LICENSE",
            "claude-plugin/provenance.json",
            "skills/how/LICENSE",
            "skills/LICENSE",
        ] {
            assert!(dir.join(path).exists(), "{path}");
        }
    }

    #[test]
    fn nothing_is_written_outside_app_data() {
        let f = fixture();
        assert!(current_dir(&f.service).starts_with(f.dir.path().join("data")));
    }

    #[cfg(unix)]
    #[test]
    fn signing_key_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let mode = std::fs::metadata(f.service.key_path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn default_profile_excludes_rea_and_social() {
        let f = fixture();
        let default = f.service.profiles().unwrap().remove(0);
        assert_eq!(default.id, DEFAULT_PROFILE);
        assert_eq!(default.skills, ["how"]);
    }

    #[test]
    fn plugin_view_holds_only_the_selection_with_notices() {
        let f = fixture();
        let (plan, selection) = f
            .service
            .plan(&[SkillDelivery::NativePlugin], None)
            .unwrap();
        let plugin = plan.plugin_dir.unwrap();
        assert_eq!(selection, ["how"]);
        assert!(plugin.join("skills/how/SKILL.md").exists());
        assert!(plugin.join("skills/how/LICENSE").exists());
        assert!(plugin.join("LICENSE").exists());
        assert!(plugin.join(".claude-plugin/plugin.json").exists());
        assert!(!plugin.join("skills/social-content").exists());
    }

    #[test]
    fn ladder_prefers_native_then_mcp_then_prompt() {
        assert_eq!(
            choose_delivery(&[SkillDelivery::PromptBootstrap, SkillDelivery::NativePlugin]),
            Some(SkillDelivery::NativePlugin)
        );
        assert_eq!(
            choose_delivery(&[
                SkillDelivery::PromptBootstrap,
                SkillDelivery::McpSkillServer
            ]),
            Some(SkillDelivery::McpSkillServer)
        );
        assert_eq!(choose_delivery(&[]), None);
        let f = fixture();
        let (plan, _) = f
            .service
            .plan(&[SkillDelivery::PromptBootstrap], None)
            .unwrap();
        assert!(plan.bootstrap.unwrap().contains("how"));
    }

    #[test]
    fn changed_file_is_detected_and_refused() {
        let f = fixture();
        write(
            &current_dir(&f.service).join("skills/how/SKILL.md"),
            "tampered",
        );
        assert!(!f.service.status().unwrap().signature_valid);
        assert!(matches!(
            f.service.plan(&[SkillDelivery::NativeSkillRoot], None),
            Err(CoreError::PackTampered(_))
        ));
    }

    #[test]
    fn added_file_is_detected() {
        let f = fixture();
        write(&current_dir(&f.service).join("skills/how/extra.md"), "x");
        assert!(matches!(
            f.service.plan(&[SkillDelivery::NativeSkillRoot], None),
            Err(CoreError::PackTampered(_))
        ));
    }

    #[test]
    fn edited_manifest_fails_its_signature() {
        let f = fixture();
        let path = current_dir(&f.service).join("manifest.json");
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replacen("how", "hax", 1)).unwrap();
        assert!(matches!(
            f.service.verified(),
            Err(CoreError::PackTampered(_))
        ));
    }

    #[test]
    fn tampered_profile_view_is_detected() {
        let f = fixture();
        let (plan, _) = f
            .service
            .plan(&[SkillDelivery::NativePlugin], None)
            .unwrap();
        write(
            &plan.plugin_dir.unwrap().join("skills/how/SKILL.md"),
            "evil",
        );
        assert!(matches!(
            f.service.plan(&[SkillDelivery::NativePlugin], None),
            Err(CoreError::PackTampered(_))
        ));
    }

    #[test]
    fn rebuild_replaces_a_tampered_pack() {
        let f = fixture();
        write(
            &current_dir(&f.service).join("skills/how/SKILL.md"),
            "tampered",
        );
        assert!(f.service.rebuild().unwrap().signature_valid);
    }

    #[test]
    fn load_is_limited_to_selection_and_manifest() {
        let f = fixture();
        let allowed = vec!["how".to_owned()];
        assert!(
            f.service
                .load("how", None, &allowed)
                .unwrap()
                .contains("# how")
        );
        assert!(
            f.service
                .load("how", Some("references/a.md"), &allowed)
                .is_ok()
        );
        assert!(f.service.load("social-content", None, &allowed).is_err());
        assert!(
            f.service
                .load("how", Some("../../manifest.json"), &allowed)
                .is_err()
        );
    }

    #[test]
    fn search_stays_inside_the_selection() {
        let f = fixture();
        let allowed = vec!["how".to_owned()];
        assert_eq!(f.service.search("does", &allowed).unwrap().len(), 1);
        assert!(f.service.search("social", &allowed).unwrap().is_empty());
    }

    #[test]
    fn real_catalog_builds_when_present() {
        let Some(source) = detect_source() else {
            return;
        };
        let dir = TempDir::new();
        let data = dir.path().join("data");
        let store = Arc::new(Store::open(&data.join("db"), "e").unwrap());
        let service = SkillService::new(store, &data, Some(source));
        let status = service.rebuild().unwrap();
        assert!(status.signature_valid);
        let enabled: Vec<_> = status.skills.iter().filter(|s| s.enabled).collect();
        assert!(!enabled.is_empty());
        assert!(enabled.iter().all(|s| !s.name.starts_with("rea-")
            && !s.name.starts_with("social-")
            && s.name != "reverse-engineer-anything"));
    }
}
