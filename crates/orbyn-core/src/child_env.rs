//! What a spawned program inherits. Orbyn can start from places that leave their own
//! markers behind: inside a coding agent's session, or from an AppImage. Those change
//! how a child behaves without any sign, so every spawn goes through this file. Only
//! variable names are ever reported; a value is compared, never kept or logged.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// Set by Claude Code in everything it starts. A CLI that sees it treats itself as a
/// nested session.
const NESTED_MARKER: &str = "CLAUDECODE";
/// Under the marker, the rest of the host session's variables go too, including ones
/// that switch a child into a reduced mode. These stay: a person sets them.
const CLAUDE_SETTINGS: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_GIT_BASH_PATH",
];
/// What a Codex session leaves for the commands it runs.
const CODEX_SESSION: &[&str] = &[
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_THREAD_ID",
];
/// Set by an AppImage's launcher. They name a mount that a child has no use for.
const APPIMAGE_ONLY: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "PYTHONHOME",
    "GDK_PIXBUF_MODULE_FILE",
];
/// Lists that an AppImage extends with folders inside its mount.
const APPIMAGE_LISTS: &[&str] = &["LD_LIBRARY_PATH", "XDG_DATA_DIRS", "PATH"];

const CLAUDE_CREDENTIALS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
const CODEX_CREDENTIALS: &[&str] = &["OPENAI_API_KEY", "CODEX_API_KEY"];
const ENDPOINTS: &[&str] = &["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"];

static PREFER_SAVED_LOGIN: AtomicBool = AtomicBool::new(false);

/// The `prefer_saved_login` preference, kept here because spawning has no store.
pub fn set_prefer_saved_login(prefer: bool) {
    PREFER_SAVED_LOGIN.store(prefer, Ordering::Relaxed);
}

/// Changes to apply to an inherited environment.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EnvPlan {
    pub remove: Vec<OsString>,
    pub set: Vec<(OsString, OsString)>,
}

fn name_of(name: &OsStr) -> String {
    name.to_string_lossy().into_owned()
}

/// Works out what to change. `engine` is true for a spawn that runs a coding engine,
/// the only one a login preference applies to.
pub fn plan(vars: &[(OsString, OsString)], engine: bool, prefer_saved: bool) -> EnvPlan {
    let has = |wanted: &str| vars.iter().any(|(name, _)| name == wanted);
    let nested = has(NESTED_MARKER);
    let app_dir = vars
        .iter()
        .find(|(name, _)| name == "APPDIR")
        .filter(|_| has("APPIMAGE"))
        .map(|(_, value)| PathBuf::from(value));
    let mut changes = EnvPlan::default();
    for (name, value) in vars {
        let text = name_of(name);
        let host_session =
            nested && text.starts_with("CLAUDE") && !CLAUDE_SETTINGS.contains(&text.as_str());
        let scrubbed_login = engine
            && prefer_saved
            && (CLAUDE_CREDENTIALS.contains(&text.as_str())
                || CODEX_CREDENTIALS.contains(&text.as_str())
                || ENDPOINTS.contains(&text.as_str()));
        if host_session || scrubbed_login || CODEX_SESSION.contains(&text.as_str()) {
            changes.remove.push(name.clone());
            continue;
        }
        let Some(mount) = &app_dir else { continue };
        if APPIMAGE_ONLY.contains(&text.as_str()) {
            changes.remove.push(name.clone());
        } else if APPIMAGE_LISTS.contains(&text.as_str()) {
            let kept: Vec<PathBuf> = std::env::split_paths(value)
                .filter(|entry| !entry.starts_with(mount))
                .collect();
            if kept.is_empty() {
                changes.remove.push(name.clone());
            } else if let Ok(joined) = std::env::join_paths(&kept)
                && joined != *value
            {
                changes.set.push((name.clone(), joined));
            }
        }
    }
    changes
}

fn apply(command: &mut Command, engine: bool) {
    let vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let changes = plan(&vars, engine, PREFER_SAVED_LOGIN.load(Ordering::Relaxed));
    for name in &changes.remove {
        command.env_remove(name);
    }
    for (name, value) in &changes.set {
        if name != "PATH" {
            command.env(name, value);
        }
    }
    let base = changes
        .set
        .iter()
        .find(|(name, _)| name == "PATH")
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var_os("PATH"));
    command.env("PATH", widened(base.as_deref()));
}

/// For git, forge CLIs, browsers and anything else that is not an engine.
pub fn for_tool(command: &mut Command) {
    apply(command, false);
}

/// For a coding engine.
pub fn for_engine(command: &mut Command) {
    apply(command, true);
}

/// Names to drop and values to set on a terminal, which is the person's own shell:
/// the login preference does not reach it.
pub fn for_terminal() -> EnvPlan {
    let vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let mut changes = plan(&vars, false, false);
    changes.set.retain(|(name, _)| name != "PATH");
    let base = std::env::var_os("PATH");
    changes.set.push(("PATH".into(), widened(base.as_deref())));
    changes
}

/// Which credential variables an engine would inherit, by name, and the origin of
/// any endpoint override. The origin drops a path and any user info, which is where
/// a secret could sit.
pub fn inherited_login(engine: &str) -> (Vec<String>, Option<String>) {
    let (names, endpoint): (&[&str], &str) = match engine {
        "claude" => (CLAUDE_CREDENTIALS, "ANTHROPIC_BASE_URL"),
        "codex" => (CODEX_CREDENTIALS, "OPENAI_BASE_URL"),
        _ => return (Vec::new(), None),
    };
    if PREFER_SAVED_LOGIN.load(Ordering::Relaxed) {
        return (Vec::new(), None);
    }
    let set = |name: &&&str| std::env::var_os(**name).is_some_and(|value| !value.is_empty());
    let found = names.iter().filter(set).map(|name| (*name).to_owned());
    let origin = std::env::var(endpoint)
        .ok()
        .and_then(|url| url_origin(&url));
    (found.collect(), origin)
}

/// `scheme://host[:port]`, or `None` for anything that does not parse as a URL.
pub fn url_origin(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let port = parsed
        .port()
        .map_or_else(String::new, |port| format!(":{port}"));
    Some(format!("{}://{host}{port}", parsed.scheme()))
}

/// PATH with the usual install folders added after what is already there. An app
/// started from Finder, the Dock or the Start menu gets a minimal PATH, and nothing
/// here runs a shell to find a better one.
pub fn widened(path: Option<&OsStr>) -> OsString {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    let dirs = DIRS.get_or_init(|| {
        tool_dirs(&Install::from_process(), cfg!(windows))
            .into_iter()
            .filter(|dir| dir.is_dir())
            .collect()
    });
    let mut entries: Vec<PathBuf> = path.map_or_else(Vec::new, |path| {
        std::env::split_paths(path).collect::<Vec<_>>()
    });
    for dir in dirs {
        if !entries.contains(dir) {
            entries.push(dir.clone());
        }
    }
    std::env::join_paths(entries).unwrap_or_else(|_| path.unwrap_or_default().to_owned())
}

/// What the search is built from, so both platforms' rules run under test anywhere.
#[derive(Debug, Default)]
pub struct Install {
    pub home: Option<PathBuf>,
    pub app_data: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub system_root: Option<PathBuf>,
    pub program_files: Option<PathBuf>,
    pub nvm_symlink: Option<PathBuf>,
    pub n_prefix: Option<PathBuf>,
    /// `prefix=` from the npm config, or `NPM_CONFIG_PREFIX`.
    pub npm_prefix: Option<PathBuf>,
    /// Installed node versions under nvm or `n`, each `.../bin`.
    pub node_versions: Vec<PathBuf>,
}

impl Install {
    fn from_process() -> Self {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let home = var("USERPROFILE")
            .filter(|_| cfg!(windows))
            .or_else(|| var("HOME"));
        let n_prefix = var("N_PREFIX");
        let mut node_versions = Vec::new();
        for root in [
            home.as_ref().map(|home| home.join(".nvm/versions/node")),
            Some(
                n_prefix
                    .clone()
                    .unwrap_or_else(|| "/usr/local".into())
                    .join("n/versions/node"),
            ),
        ]
        .into_iter()
        .flatten()
        {
            node_versions.extend(newest_version(&root).map(|dir| dir.join("bin")));
        }
        let npmrc = home
            .as_ref()
            .and_then(|home| std::fs::read_to_string(home.join(".npmrc")).ok());
        Self {
            npm_prefix: var("NPM_CONFIG_PREFIX")
                .or_else(|| npmrc.as_deref().and_then(npm_prefix).map(PathBuf::from)),
            app_data: var("APPDATA"),
            local_app_data: var("LOCALAPPDATA"),
            system_root: var("SystemRoot"),
            program_files: var("ProgramFiles"),
            nvm_symlink: var("NVM_SYMLINK"),
            n_prefix,
            node_versions,
            home,
        }
    }
}

/// The highest `vN.N.N` folder, by number rather than by name.
fn newest_version(root: &Path) -> Option<PathBuf> {
    let parse = |name: &str| -> Option<Vec<u64>> {
        name.trim_start_matches('v')
            .split('.')
            .map(|part| part.parse().ok())
            .collect()
    };
    std::fs::read_dir(root)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            Some((parse(&entry.file_name().to_string_lossy())?, entry.path()))
        })
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, path)| path)
}

/// The `prefix` line of an `.npmrc`. A value with a variable in it is left alone,
/// because expanding it is npm's business.
pub fn npm_prefix(text: &str) -> Option<&str> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        let value = value.trim().trim_matches('"');
        (key.trim() == "prefix" && !value.is_empty() && !value.contains('$')).then_some(value)
    })
}

/// Folders where tools are usually installed, most likely first.
pub fn tool_dirs(install: &Install, windows: bool) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let in_home = |paths: &[&str], dirs: &mut Vec<PathBuf>| {
        if let Some(home) = &install.home {
            dirs.extend(paths.iter().map(|path| home.join(path)));
        }
    };
    if windows {
        dirs.extend(install.app_data.iter().map(|dir| dir.join("npm")));
        if let Some(local) = &install.local_app_data {
            dirs.push(local.join("pnpm"));
            dirs.push(local.join("Volta").join("bin"));
            dirs.push(local.join("fnm_multishells"));
            dirs.push(local.join("Programs").join("nodejs"));
        }
        dirs.extend(install.nvm_symlink.iter().cloned());
        dirs.extend(install.program_files.iter().map(|dir| dir.join("nodejs")));
        dirs.extend(
            install
                .program_files
                .iter()
                .map(|dir| dir.join("Git").join("cmd")),
        );
        in_home(&[".cargo/bin", ".bun/bin", ".local/bin"], &mut dirs);
        dirs.extend(install.npm_prefix.iter().cloned());
        if let Some(root) = &install.system_root {
            dirs.push(root.join("System32").join("WindowsPowerShell").join("v1.0"));
        }
        return dirs;
    }
    dirs.extend(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"].map(PathBuf::from));
    in_home(
        &[
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".npm-global/bin",
            "Library/pnpm",
            ".local/share/pnpm",
            ".fnm/aliases/default/bin",
            ".local/share/fnm/aliases/default/bin",
            "Library/Application Support/fnm/aliases/default/bin",
        ],
        &mut dirs,
    );
    dirs.extend(install.npm_prefix.iter().map(|prefix| prefix.join("bin")));
    dirs.extend(install.n_prefix.iter().map(|prefix| prefix.join("bin")));
    dirs.extend(install.node_versions.iter().cloned());
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(name, value)| ((*name).into(), (*value).into()))
            .collect()
    }

    fn removed(changes: &EnvPlan) -> Vec<String> {
        changes.remove.iter().map(|name| name_of(name)).collect()
    }

    #[test]
    fn a_nested_session_loses_its_host_variables_and_keeps_what_a_person_set() {
        let inherited = vars(&[
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_SIMPLE", "1"),
            ("CLAUDE_CODE_SESSION_ID", "s"),
            ("CLAUDE_CONFIG_DIR", "/mine"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("HOME", "/h"),
        ]);
        let gone = removed(&plan(&inherited, false, false));
        assert_eq!(
            gone,
            ["CLAUDECODE", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SESSION_ID"]
        );
    }

    #[test]
    fn without_the_marker_claude_settings_are_left_alone() {
        let inherited = vars(&[
            ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "1"),
            ("ANTHROPIC_API_KEY", "k"),
        ]);
        assert_eq!(plan(&inherited, true, false), EnvPlan::default());
    }

    #[test]
    fn a_codex_session_marker_never_reaches_a_child() {
        let gone = removed(&plan(&vars(&[("CODEX_SANDBOX", "seatbelt")]), false, false));
        assert_eq!(gone, ["CODEX_SANDBOX"]);
    }

    #[test]
    fn an_appimage_is_removed_only_from_what_it_added() {
        let inherited = vars(&[
            ("APPIMAGE", "/a/app.AppImage"),
            ("APPDIR", "/tmp/.mount"),
            ("ARGV0", "app"),
            ("LD_LIBRARY_PATH", "/tmp/.mount/usr/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount/share:/usr/share"),
        ]);
        let changes = plan(&inherited, false, false);
        let gone = removed(&changes);
        assert!(gone.contains(&"ARGV0".to_owned()), "{gone:?}");
        assert!(gone.contains(&"LD_LIBRARY_PATH".to_owned()), "{gone:?}");
        assert_eq!(
            changes.set,
            vec![("XDG_DATA_DIRS".into(), "/usr/share".into())]
        );
    }

    #[test]
    fn argv0_alone_is_not_an_appimage() {
        let inherited = vars(&[("ARGV0", "zsh"), ("APPDIR", "/x")]);
        assert_eq!(plan(&inherited, false, false), EnvPlan::default());
    }

    #[test]
    fn saved_login_applies_to_engines_only_and_only_when_asked() {
        let inherited = vars(&[
            ("ANTHROPIC_API_KEY", "k"),
            ("OPENAI_BASE_URL", "https://x"),
            ("PATH", "/bin"),
        ]);
        assert_eq!(plan(&inherited, true, false), EnvPlan::default());
        assert_eq!(plan(&inherited, false, true), EnvPlan::default());
        assert_eq!(
            removed(&plan(&inherited, true, true)),
            ["ANTHROPIC_API_KEY", "OPENAI_BASE_URL"]
        );
    }

    #[test]
    fn an_origin_never_carries_a_path_or_user_info() {
        assert_eq!(
            url_origin("https://me:secret@proxy.example:8443/v1/key").as_deref(),
            Some("https://proxy.example:8443")
        );
        assert_eq!(url_origin("not a url"), None);
    }

    #[test]
    fn existing_path_entries_keep_their_order_and_come_first() {
        let path = std::env::join_paths(["/first", "/second"]).unwrap();
        let wide = widened(Some(&path));
        let entries: Vec<PathBuf> = std::env::split_paths(&wide).collect();
        assert_eq!(
            entries[..2],
            [PathBuf::from("/first"), PathBuf::from("/second")]
        );
        let unique: std::collections::HashSet<_> = entries.iter().collect();
        assert_eq!(unique.len(), entries.len());
    }

    #[test]
    fn install_folders_follow_the_platform() {
        let install = Install {
            home: Some("/h".into()),
            app_data: Some("/roaming".into()),
            local_app_data: Some("/local".into()),
            system_root: Some("/win".into()),
            npm_prefix: Some("/prefix".into()),
            node_versions: vec!["/h/.nvm/versions/node/v22.1.0/bin".into()],
            ..Install::default()
        };
        let unix = tool_dirs(&install, false);
        assert!(unix.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(unix.contains(&PathBuf::from("/h/.cargo/bin")));
        assert!(unix.contains(&PathBuf::from("/prefix/bin")));
        assert!(unix.contains(&PathBuf::from("/h/.nvm/versions/node/v22.1.0/bin")));
        let windows = tool_dirs(&install, true);
        assert_eq!(windows[0], PathBuf::from("/roaming/npm"));
        assert!(windows.contains(&PathBuf::from("/local/pnpm")));
        assert!(!windows.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn a_newer_version_wins_by_number_and_other_folders_are_ignored() {
        let dir = crate::testing::TempDir::new();
        for name in ["v9.11.0", "v22.1.0", "v22.10.0", "latest"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        assert_eq!(
            newest_version(dir.path()).unwrap().file_name().unwrap(),
            "v22.10.0"
        );
    }

    #[test]
    fn the_npm_prefix_line_is_found_and_a_variable_is_left_to_npm() {
        assert_eq!(npm_prefix("a=b\nprefix = \"/opt/n\"\n"), Some("/opt/n"));
        assert_eq!(npm_prefix("prefix=${HOME}/n\n"), None);
        assert_eq!(npm_prefix("registry=x\n"), None);
    }
}
