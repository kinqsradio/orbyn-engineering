//! Skills are read in place from the workspace library. Engines with native
//! discovery find them on their own; this service backs the MCP tools, the
//! bootstrap list and the settings view. A skill's identity is the library's
//! revision plus its dirty flag.

use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::sync::Arc;

use orbyn_contracts::{SkillDelivery, SkillPackStatus, SkillProfile, SkillSummary};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{CoreError, Result};
use crate::store::Store;
use crate::util::canonicalize;
use crate::workspace::{Workspace, native_skills_available};

pub const DEFAULT_PROFILE: &str = "default";

#[derive(Clone, Debug, PartialEq)]
pub struct LibrarySkill {
    pub name: String,
    pub category: String,
    pub description: String,
}

/// How this run's engine gets its skills.
#[derive(Clone, Debug, PartialEq)]
pub struct SkillRoute {
    /// False sends the engine to the MCP tools.
    pub native: bool,
    pub selection: Vec<String>,
}

pub struct SkillService {
    store: Arc<Store>,
    workspace: Arc<Workspace>,
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

/// Reads `name` and `description` from the leading `---` block of a SKILL.md.
pub fn parse_frontmatter(text: &str) -> Option<(String, String)> {
    let body = text.strip_prefix("---")?;
    let end = body.find("\n---")?;
    let mut name = None;
    let mut description = None;
    for line in body[..end].lines() {
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|rest| rest.strip_suffix('"'))
                .map_or_else(|| value.to_owned(), |inner| inner.replace("\\\"", "\""));
            match key.trim() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }
    Some((name?, description.unwrap_or_default()))
}

/// REA and social skills are specialist choices.
pub fn default_selection(skills: &[LibrarySkill]) -> BTreeSet<String> {
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

/// Native discovery needs the engine to support it and the links to exist.
pub fn route_is_native(supported: &[SkillDelivery], links_ok: bool) -> bool {
    links_ok && supported.contains(&SkillDelivery::NativeSkillRoot)
}

impl SkillService {
    pub fn new(store: Arc<Store>, workspace: Arc<Workspace>) -> Self {
        Self { store, workspace }
    }

    pub fn catalog(&self) -> Result<Vec<LibrarySkill>> {
        let root = match self.workspace.root() {
            Ok(root) => root,
            Err(CoreError::WorkspaceRequired) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let skills = root.join("skills");
        let catalog: Catalog =
            serde_json::from_slice(&std::fs::read(skills.join("catalog.json"))?)?;
        Ok(catalog
            .skills
            .into_iter()
            .filter_map(|entry| {
                let text =
                    std::fs::read_to_string(skills.join(&entry.name).join("SKILL.md")).ok()?;
                let (name, description) = parse_frontmatter(&text)?;
                (name == entry.name).then_some(LibrarySkill {
                    name,
                    category: entry.category,
                    description,
                })
            })
            .collect())
    }

    pub async fn status(&self) -> Result<SkillPackStatus> {
        let Ok(root) = self.workspace.root() else {
            return Ok(SkillPackStatus {
                version: String::new(),
                digest: String::new(),
                signature_valid: false,
                source: None,
                skills: Vec::new(),
            });
        };
        let (revision, dirty) = self.workspace.identity().await?;
        let skills = self.catalog()?;
        let enabled = default_selection(&skills);
        let short: String = revision.chars().take(12).collect();
        Ok(SkillPackStatus {
            version: if dirty {
                format!("{short}-dirty")
            } else {
                short
            },
            digest: revision,
            signature_valid: true,
            source: Some(root.to_string_lossy().into_owned()),
            skills: skills
                .into_iter()
                .map(|skill| SkillSummary {
                    enabled: enabled.contains(&skill.name),
                    name: skill.name,
                    category: skill.category,
                    description: skill.description,
                })
                .collect(),
        })
    }

    pub fn profiles(&self) -> Result<Vec<SkillProfile>> {
        let mut profiles = vec![SkillProfile {
            id: DEFAULT_PROFILE.into(),
            name: "Default".into(),
            skills: default_selection(&self.catalog()?).into_iter().collect(),
        }];
        profiles.extend(self.store.list_profiles()?);
        Ok(profiles)
    }

    fn selection(&self, profile: Option<&str>) -> Result<Vec<String>> {
        match profile {
            None | Some(DEFAULT_PROFILE) => {
                Ok(default_selection(&self.catalog()?).into_iter().collect())
            }
            Some(id) => self
                .store
                .profile(id)?
                .map(|profile| profile.skills)
                .ok_or_else(|| CoreError::NotFound("skill profile".into())),
        }
    }

    pub fn route(&self, supported: &[SkillDelivery], profile: Option<&str>) -> Result<SkillRoute> {
        let root = self.workspace.root()?;
        Ok(SkillRoute {
            native: route_is_native(supported, native_skills_available(&root)),
            selection: self.selection(profile)?,
        })
    }

    pub fn search(&self, query: &str, allowed: &[String]) -> Result<Vec<Value>> {
        let terms: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        Ok(self
            .catalog()?
            .iter()
            .filter(|skill| allowed.contains(&skill.name))
            .filter(|skill| {
                let text = format!("{} {}", skill.name, skill.description).to_lowercase();
                terms.iter().all(|term| text.contains(term))
            })
            .map(|skill| json!({ "name": skill.name, "description": skill.description }))
            .collect())
    }

    /// Reads a file of an allowed skill. The resolved path must stay inside that
    /// skill's folder, so neither `..` nor a symlink can reach anything else.
    pub fn load(&self, name: &str, file: Option<&str>, allowed: &[String]) -> Result<String> {
        if !allowed.iter().any(|skill| skill == name) {
            return Err(CoreError::NotFound(format!("skill {name}")));
        }
        let relative = Path::new(file.unwrap_or("SKILL.md"));
        if !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(CoreError::NotFound("skill file".into()));
        }
        let root = canonicalize(&self.workspace.root()?.join("skills").join(name))
            .map_err(|_| CoreError::NotFound(format!("skill {name}")))?;
        let path = canonicalize(&root.join(relative))
            .map_err(|_| CoreError::NotFound("skill file".into()))?;
        if !path.starts_with(&root) {
            return Err(CoreError::NotFound("skill file".into()));
        }
        Ok(std::fs::read_to_string(path)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{TempDir, library};
    use orbyn_contracts::WorkspaceSetup;

    async fn fixture() -> (TempDir, SkillService) {
        let dir = TempDir::new();
        let root = library(&dir.path().join("library"));
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = Arc::new(Store::open(&data.join("db"), "e").unwrap());
        let workspace = Arc::new(Workspace::new(store.clone(), data, "u".into()).unwrap());
        workspace
            .setup(WorkspaceSetup {
                url: None,
                adopt_path: Some(root.to_string_lossy().into_owned()),
            })
            .await
            .unwrap();
        (dir, SkillService::new(store, workspace))
    }

    #[test]
    fn frontmatter_reads_quoted_values_with_colons() {
        assert_eq!(
            parse_frontmatter("---\nname: a\ndescription: \"b: c\"\n---\nbody"),
            Some(("a".into(), "b: c".into()))
        );
        assert_eq!(parse_frontmatter("no frontmatter"), None);
    }

    #[tokio::test]
    async fn identity_is_the_revision_with_a_dirty_flag() {
        let (dir, service) = fixture().await;
        let clean = service.status().await.unwrap();
        assert_eq!(clean.digest.len(), 40);
        assert!(!clean.version.ends_with("-dirty"));
        std::fs::write(dir.path().join("library/AGENTS.md"), "edit").unwrap();
        assert!(service.status().await.unwrap().version.ends_with("-dirty"));
    }

    #[tokio::test]
    async fn default_profile_filters_but_nothing_is_copied() {
        let (dir, service) = fixture().await;
        assert_eq!(service.profiles().unwrap()[0].skills, ["how"]);
        assert!(!dir.path().join("data/skills").exists());
    }

    #[tokio::test]
    async fn local_edits_are_what_the_tools_read() {
        let (dir, service) = fixture().await;
        let allowed = vec!["how".to_owned()];
        std::fs::write(
            dir.path().join("library/skills/how/SKILL.md"),
            "---\nname: how\n---\nedited\n",
        )
        .unwrap();
        assert!(
            service
                .load("how", None, &allowed)
                .unwrap()
                .contains("edited")
        );
    }

    #[tokio::test]
    async fn load_stays_inside_an_allowed_skill() {
        let (dir, service) = fixture().await;
        let allowed = vec!["how".to_owned()];
        assert!(
            service
                .load("how", None, &allowed)
                .unwrap()
                .contains("# how")
        );
        assert!(service.load("social-content", None, &allowed).is_err());
        assert!(
            service
                .load("how", Some("../../AGENTS.md"), &allowed)
                .is_err()
        );
        assert!(service.load("how", Some("/etc/hosts"), &allowed).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                dir.path().join("library/AGENTS.md"),
                dir.path().join("library/skills/how/escape.md"),
            )
            .unwrap();
            assert!(service.load("how", Some("escape.md"), &allowed).is_err());
        }
    }

    #[tokio::test]
    async fn search_stays_inside_the_selection() {
        let (_dir, service) = fixture().await;
        let allowed = vec!["how".to_owned()];
        assert_eq!(service.search("trace", &allowed).unwrap().len(), 1);
        assert!(service.search("posts", &allowed).unwrap().is_empty());
    }

    #[test]
    fn missing_links_fall_back_to_mcp() {
        let native = [
            SkillDelivery::NativeSkillRoot,
            SkillDelivery::McpSkillServer,
        ];
        assert!(route_is_native(&native, true));
        assert!(!route_is_native(&native, false));
        assert!(!route_is_native(&[SkillDelivery::McpSkillServer], true));
    }
}
