//! Claude Code's own skills, in the places its CLI reads them: the config
//! directory, the start folder's and the checkout's `.claude/skills`, and
//! enabled plugins. The CLI loads them itself; Orbyn reads the same sources
//! only to offer their names in the composer. Nothing is copied, run or written.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::util::canonicalize;

const CONFIG_ENV: &str = "CLAUDE_CONFIG_DIR";
pub(crate) const PLUGIN_CACHE_ENV: &str = "CLAUDE_CODE_PLUGIN_CACHE_DIR";

/// A skill the Claude CLI can already find for this checkout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeSkill {
    pub name: String,
    pub description: String,
}

/// The directory the CLI uses for its own config. A relative inherited value
/// resolves against where the engine starts, as the CLI resolves it.
pub fn config_dir(base: &Path) -> Option<PathBuf> {
    let inherited = std::env::var_os(CONFIG_ENV);
    resolve_config_dir(inherited.as_deref(), base)
}

fn resolve_config_dir(value: Option<&OsStr>, base: &Path) -> Option<PathBuf> {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        return Some(if path.is_absolute() {
            path
        } else {
            base.join(path)
        });
    }
    home().map(|home| home.join(".claude"))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Every user-invocable skill the CLI would load for a run that starts at
/// `base` on `checkout`. A name found earlier wins: config, then the start
/// folder, then the checkout, then plugins. `base` is where the engine starts
/// (the workspace root for a native run) and `checkout` is the directory the
/// run adds. `plugin_cache` is the CLI's `CLAUDE_CODE_PLUGIN_CACHE_DIR`.
pub fn discover(
    config: &Path,
    base: &Path,
    checkout: &Path,
    plugin_cache: Option<&Path>,
) -> Vec<ClaudeSkill> {
    let settings = read_settings(config, base);
    let mut found = BTreeMap::new();
    for root in skill_roots(config, base, checkout, plugin_cache, &settings) {
        read_root(&root, &settings, &mut found);
    }
    found.into_values().collect()
}

/// A folder of skill directories. A plugin also allows one `SKILL.md` at its
/// root, whose declared name is prefixed like its folder skills.
struct SkillRoot {
    directory: PathBuf,
    prefix: Option<String>,
    /// Config and project skills honour `skillOverrides`; plugin names do not.
    overrides: bool,
}

#[derive(Default)]
struct SkillSettings {
    disabled: BTreeSet<String>,
    enabled_plugins: BTreeMap<String, bool>,
}

fn skill_roots(
    config: &Path,
    base: &Path,
    checkout: &Path,
    plugin_cache: Option<&Path>,
    settings: &SkillSettings,
) -> Vec<SkillRoot> {
    let mut roots = vec![
        SkillRoot {
            directory: config.join("skills"),
            prefix: None,
            overrides: true,
        },
        SkillRoot {
            directory: base.join(".claude/skills"),
            prefix: None,
            overrides: true,
        },
    ];
    let added = checkout.join(".claude/skills");
    if added != roots[1].directory {
        roots.push(SkillRoot {
            directory: added,
            prefix: None,
            overrides: true,
        });
    }
    roots.extend(plugin_roots(config, base, checkout, plugin_cache, settings));
    roots
}

fn read_root(
    root: &SkillRoot,
    settings: &SkillSettings,
    found: &mut BTreeMap<String, ClaudeSkill>,
) {
    let single = root.prefix.is_some() && root.directory.join("SKILL.md").is_file();
    let entries = if single {
        vec![root.directory.clone()]
    } else {
        directories(&root.directory)
    };
    for directory in entries {
        let Some(text) = std::fs::read_to_string(directory.join("SKILL.md")).ok() else {
            continue;
        };
        let Some(front) = frontmatter(&text) else {
            continue;
        };
        let Some(folder) = directory.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        let folder = folder.trim();
        if folder.is_empty() {
            continue;
        }
        let name = match &root.prefix {
            Some(prefix) => {
                let declared = single.then_some(front.name.as_deref()).flatten();
                let naked = declared
                    .and_then(|name| name.strip_prefix(&format!("{prefix}:")))
                    .unwrap_or_else(|| declared.unwrap_or(folder));
                let naked = if naked.trim().is_empty() {
                    folder
                } else {
                    naked
                };
                format!("{}:{}", token_name(prefix), token_name(naked))
            }
            None => folder.to_owned(),
        };
        if found.contains_key(&name) {
            continue;
        }
        if root.overrides && settings.disabled.contains(&name) {
            continue;
        }
        if front.user_invocable == Some(false) {
            continue;
        }
        found.insert(
            name.clone(),
            ClaudeSkill {
                name,
                description: front.description.unwrap_or_default(),
            },
        );
    }
}

fn directories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    found.sort();
    found
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    user_invocable: Option<bool>,
}

/// The leading `---` block of a `SKILL.md`. A file without a closing marker is
/// not a skill Claude would load.
fn frontmatter(text: &str) -> Option<Frontmatter> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut front = Frontmatter::default();
    for line in lines {
        if line.trim() == "---" {
            return Some(front);
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = unquote(value.trim());
        match key.trim() {
            "name" if !value.is_empty() => front.name = Some(value),
            "description" => front.description = Some(value),
            "user-invocable" => front.user_invocable = boolean(&value),
            _ => {}
        }
    }
    None
}

fn unquote(value: &str) -> String {
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner.replace(&format!("\\{quote}"), &quote.to_string());
        }
    }
    value.to_owned()
}

fn boolean(value: &str) -> Option<bool> {
    match value.trim().to_lowercase().as_str() {
        "true" | "yes" | "on" | "y" | "1" => Some(true),
        "false" | "no" | "off" | "n" | "0" => Some(false),
        _ => None,
    }
}

/// Skill and plugin names the composer's `$` token can carry.
fn token_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn read_settings(config: &Path, checkout: &Path) -> SkillSettings {
    let mut settings = SkillSettings::default();
    for path in settings_files(config, checkout) {
        let Some(value) = read_json(&path) else {
            continue;
        };
        if let Some(overrides) = value.get("skillOverrides").and_then(Value::as_object) {
            for (name, value) in overrides {
                if value.as_str() == Some("off") {
                    settings.disabled.insert(name.clone());
                } else {
                    settings.disabled.remove(name);
                }
            }
        }
        if let Some(plugins) = value.get("enabledPlugins").and_then(Value::as_object) {
            for (key, enabled) in plugins {
                match enabled.as_bool() {
                    Some(enabled) => {
                        settings.enabled_plugins.insert(key.clone(), enabled);
                    }
                    // An extended value replaces a lower one without enabling it.
                    None => {
                        settings.enabled_plugins.remove(key);
                    }
                }
            }
        }
    }
    settings
}

/// Lowest precedence first: user, project, local, then a linked worktree's
/// repository-local file. Project settings belong to where the engine starts.
fn settings_files(config: &Path, base: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        config.join("settings.json"),
        base.join(".claude/settings.json"),
        base.join(".claude/settings.local.json"),
    ];
    if let Some(root) = repository_root(base) {
        let local = root.join(".claude/settings.local.json");
        if !paths.contains(&local) {
            paths.push(local);
        }
    }
    paths
}

fn plugin_roots(
    config: &Path,
    base: &Path,
    checkout: &Path,
    plugin_cache: Option<&Path>,
    settings: &SkillSettings,
) -> Vec<SkillRoot> {
    let plugins = plugin_cache
        .map(|path| resolve(base, path))
        .unwrap_or_else(|| config.join("plugins"));
    let Some(installed) = read_json(&plugins.join("installed_plugins.json")) else {
        return Vec::new();
    };
    let Some(entries) = installed.get("plugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    let workspace = canonical(base);
    let added = canonical(checkout);
    let repository = common_git(base);
    let mut roots = Vec::new();
    for key in entries.keys() {
        if settings.enabled_plugins.get(key) != Some(&true) {
            continue;
        }
        let Some(installs) = entries.get(key).and_then(Value::as_array) else {
            continue;
        };
        let applicable: Vec<&Value> = installs
            .iter()
            .filter(|entry| applicable(entry, &workspace, &added, repository.as_deref()))
            .collect();
        let Some(install) = applicable
            .iter()
            .find(|entry| install_path(base, entry).is_some_and(|path| path.exists()))
            .or_else(|| applicable.first())
        else {
            continue;
        };
        let Some(install) = install_path(base, install) else {
            continue;
        };
        let manifest = read_json(&install.join(".claude-plugin/plugin.json"));
        let prefix = manifest
            .as_ref()
            .and_then(|manifest| manifest.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .or_else(|| key.split('@').next().map(str::to_owned));
        let Some(prefix) = prefix else {
            continue;
        };
        let default = install.join("skills");
        let declared = manifest
            .as_ref()
            .and_then(|manifest| manifest.get("skills"))
            .and_then(declared_roots);
        if default.is_dir() {
            roots.push(SkillRoot {
                directory: default,
                prefix: Some(prefix.clone()),
                overrides: false,
            });
        }
        for relative in declared.iter().flatten() {
            let directory = resolve(&install, Path::new(&relative));
            if !directory.is_dir() || !inside(&install, &directory) {
                continue;
            }
            roots.push(SkillRoot {
                directory,
                prefix: Some(prefix.clone()),
                overrides: false,
            });
        }
        if declared.is_none()
            && install.join("SKILL.md").is_file()
            && !roots.iter().any(|root| root.directory == install)
        {
            roots.push(SkillRoot {
                directory: install,
                prefix: Some(prefix),
                overrides: false,
            });
        }
    }
    roots
}

fn declared_roots(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::String(path) => Some(vec![path.clone()]),
        Value::Array(paths) => Some(
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ),
        _ => None,
    }
}

fn applicable(entry: &Value, workspace: &Path, added: &Path, repository: Option<&Path>) -> bool {
    match entry.get("scope").and_then(Value::as_str) {
        Some("user" | "managed") => true,
        Some("project" | "local") => {
            let Some(project) = entry.get("projectPath").and_then(Value::as_str) else {
                return false;
            };
            let project = canonical(Path::new(project));
            if project == workspace || project == added {
                return true;
            }
            repository.is_some() && common_git(&project).as_deref() == repository
        }
        _ => false,
    }
}

fn install_path(base: &Path, entry: &Value) -> Option<PathBuf> {
    entry
        .get("installPath")
        .and_then(Value::as_str)
        .map(|path| resolve(base, Path::new(path)))
}

fn resolve(base: &Path, path: &Path) -> PathBuf {
    let path = expand_home(path);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn expand_home(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if text == "~" {
        return home().unwrap_or_else(|| path.to_path_buf());
    }
    let rest = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\"));
    match rest {
        Some(rest) => home().map_or_else(|| path.to_path_buf(), |home| home.join(rest)),
        None => path.to_path_buf(),
    }
}

fn canonical(path: &Path) -> PathBuf {
    canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The working-tree root that holds this path's `.git`, when there is one.
fn repository_root(path: &Path) -> Option<PathBuf> {
    let start = canonical(path);
    start
        .ancestors()
        .find(|directory| directory.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The Git directory shared by a checkout and its linked worktrees, so plugin
/// installs registered for either apply to both.
fn common_git(path: &Path) -> Option<PathBuf> {
    let root = repository_root(path)?;
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some(canonical(&dot));
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let gitdir = text.strip_prefix("gitdir:")?.trim();
    let gitdir = resolve(&root, Path::new(gitdir));
    let Some(common) = std::fs::read_to_string(gitdir.join("commondir")).ok() else {
        return Some(canonical(&gitdir));
    };
    Some(canonical(&resolve(&gitdir, Path::new(common.trim()))))
}

fn inside(root: &Path, path: &Path) -> bool {
    let root = canonical(root);
    path.starts_with(&root) || canonical(path).starts_with(&root)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn skill(root: &Path, name: &str, text: &str) {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("SKILL.md"), text).unwrap();
    }

    fn names(skills: &[ClaudeSkill]) -> Vec<&str> {
        skills.iter().map(|skill| skill.name.as_str()).collect()
    }

    #[test]
    fn config_project_and_enabled_plugins_are_read_in_that_order() {
        let dir = TempDir::new();
        let config = dir.path().join("claude");
        let checkout = dir.path().join("repo");
        skill(
            &config.join("skills"),
            "shared",
            "---\nname: shared\ndescription: from config\n---\n",
        );
        skill(
            &config.join("skills"),
            "user-only",
            "---\nname: user-only\ndescription: user\n---\n",
        );
        skill(
            &checkout.join(".claude/skills"),
            "shared",
            "---\nname: shared\ndescription: from project\n---\n",
        );
        skill(
            &checkout.join(".claude/skills"),
            "project-only",
            "---\nname: project-only\ndescription: project\n---\n",
        );
        let plugin = config.join("plugins/cache/demo/1.0.0");
        skill(
            &plugin.join("skills"),
            "plugin-skill",
            "---\nname: plugin-skill\ndescription: plugin\n---\n",
        );
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"demo"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(config.join("plugins")).unwrap();
        std::fs::write(
            config.join("plugins/installed_plugins.json"),
            serde_json::json!({ "plugins": { "demo@market": [
                { "scope": "user", "installPath": plugin }
            ] } })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"enabledPlugins":{"demo@market":true}}"#,
        )
        .unwrap();

        let found = discover(&config, &checkout, &checkout, None);
        assert_eq!(
            names(&found),
            ["demo:plugin-skill", "project-only", "shared", "user-only"]
        );
        let shared = found.iter().find(|skill| skill.name == "shared").unwrap();
        assert_eq!(shared.description, "from config");
    }

    #[test]
    fn the_start_folder_and_the_added_checkout_both_contribute() {
        let dir = TempDir::new();
        let config = dir.path().join("claude");
        let base = dir.path().join("library");
        let checkout = dir.path().join("repo");
        skill(
            &base.join(".claude/skills"),
            "library-skill",
            "---\nname: library-skill\ndescription: library\n---\n",
        );
        skill(
            &checkout.join(".claude/skills"),
            "checkout-skill",
            "---\nname: checkout-skill\ndescription: checkout\n---\n",
        );
        std::fs::create_dir_all(base.join(".claude")).unwrap();
        std::fs::write(
            base.join(".claude/settings.json"),
            r#"{"skillOverrides":{"library-skill":"off"}}"#,
        )
        .unwrap();

        let found = discover(&config, &base, &checkout, None);
        assert_eq!(names(&found), ["checkout-skill"]);
    }

    #[test]
    fn disabled_plugins_off_overrides_and_private_skills_stay_out() {
        let dir = TempDir::new();
        let config = dir.path().join("claude");
        let checkout = dir.path().join("repo");
        for name in ["off", "kept"] {
            skill(
                &config.join("skills"),
                name,
                &format!("---\nname: {name}\ndescription: {name}\n---\n"),
            );
        }
        skill(
            &config.join("skills"),
            "hidden",
            "---\nname: hidden\nuser-invocable: false\n---\n",
        );
        let plugin = config.join("plugins/cache/demo/1.0.0");
        skill(
            &plugin.join("skills"),
            "disabled",
            "---\nname: disabled\ndescription: no\n---\n",
        );
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"demo"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(config.join("plugins")).unwrap();
        std::fs::write(
            config.join("plugins/installed_plugins.json"),
            serde_json::json!({ "plugins": {
                "on@market": [{ "scope": "user", "installPath": plugin }],
                "off@market": [{ "scope": "user", "installPath": plugin }]
            } })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"enabledPlugins":{"on@market":true,"off@market":false},"skillOverrides":{"off":"off","kept":"user-invocable-only"}}"#,
        )
        .unwrap();

        let found = discover(&config, &checkout, &checkout, None);
        assert_eq!(names(&found), ["demo:disabled", "kept"]);
    }

    #[test]
    fn a_plugin_cannot_declare_a_root_outside_itself() {
        let dir = TempDir::new();
        let config = dir.path().join("claude");
        let checkout = dir.path().join("repo");
        let plugin = config.join("plugins/cache/demo/1.0.0");
        skill(
            &plugin.join("inside"),
            "listed",
            "---\nname: listed\ndescription: listed\n---\n",
        );
        skill(
            &dir.path().join("escape"),
            "escaped",
            "---\nname: escaped\ndescription: escaped\n---\n",
        );
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"demo","skills":["./inside","../escape"]}"#,
        )
        .unwrap();
        std::fs::create_dir_all(config.join("plugins")).unwrap();
        std::fs::write(
            config.join("plugins/installed_plugins.json"),
            serde_json::json!({ "plugins": { "demo@market": [
                { "scope": "user", "installPath": plugin }
            ] } })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"enabledPlugins":{"demo@market":true}}"#,
        )
        .unwrap();

        let found = discover(&config, &checkout, &checkout, None);
        assert_eq!(names(&found), ["demo:listed"]);
    }

    #[test]
    fn a_project_scoped_plugin_only_applies_to_its_checkout_or_worktree() {
        let dir = TempDir::new();
        let config = dir.path().join("claude");
        let checkout = dir.path().join("repo");
        let elsewhere = dir.path().join("other");
        let worktree = dir.path().join("worktree");
        let git_dir = checkout.join(".git/worktrees/linked");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("commondir"), "../..").unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}", git_dir.display()),
        )
        .unwrap();
        let plugin = config.join("plugins/cache/demo/1.0.0");
        skill(
            &plugin.join("skills"),
            "here",
            "---\nname: here\ndescription: here\n---\n",
        );
        std::fs::create_dir_all(config.join("plugins")).unwrap();
        std::fs::write(
            config.join("plugins/installed_plugins.json"),
            serde_json::json!({ "plugins": { "demo@market": [
                { "scope": "project", "projectPath": checkout, "installPath": plugin }
            ] } })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"enabledPlugins":{"demo@market":true}}"#,
        )
        .unwrap();

        assert_eq!(
            names(&discover(&config, &checkout, &checkout, None)),
            ["demo:here"]
        );
        assert_eq!(
            names(&discover(&config, &worktree, &worktree, None)),
            ["demo:here"]
        );
        assert!(discover(&config, &elsewhere, &elsewhere, None).is_empty());
    }

    #[test]
    fn a_relative_config_directory_resolves_from_the_engine_start() {
        let base = Path::new("/library");
        assert_eq!(
            resolve_config_dir(Some(OsStr::new(".claude-alt")), base),
            Some(PathBuf::from("/library/.claude-alt"))
        );
        assert_eq!(
            resolve_config_dir(Some(OsStr::new("/mine")), base),
            Some(PathBuf::from("/mine"))
        );
        assert_eq!(
            resolve_config_dir(None, base),
            home().map(|home| home.join(".claude"))
        );
    }
}
