//! Finds which installer provably owns an engine binary. Ownership comes from
//! the resolved path together with the installer's own answer about where it
//! installs. Anything less stays `Unknown`, which means manual instructions.

use std::path::{Path, PathBuf};
use std::time::Duration;

use orbyn_contracts::InstallerKind;

use super::probe::{capture, real_path};
use crate::driver::{EngineProbe, UpdatePlan};
use crate::process::resolve;

const ROOT_TIMEOUT: Duration = Duration::from_secs(5);

/// How one engine is packaged.
pub struct PackageSpec {
    pub npm_package: &'static str,
    pub brew_names: &'static [&'static str],
    pub winget_ids: &'static [&'static str],
    /// True when the given normalized path belongs to the engine's own updater.
    pub native_owner: fn(&str) -> bool,
}

pub const CLAUDE: PackageSpec = PackageSpec {
    npm_package: "@anthropic-ai/claude-code",
    brew_names: &["claude-code"],
    winget_ids: &["Anthropic.ClaudeCode"],
    native_owner: |path| {
        path.ends_with("/.local/bin/claude")
            || path.ends_with("/.local/bin/claude.exe")
            || path.contains("/.local/share/claude/")
    },
};

pub const CODEX: PackageSpec = PackageSpec {
    npm_package: "@openai/codex",
    brew_names: &["codex"],
    winget_ids: &["OpenAI.Codex"],
    native_owner: |path| path.contains("/packages/standalone/"),
};

/// Install locations reported by the tools themselves. `None` means the tool is
/// absent or did not answer, so it cannot be proven the owner.
#[derive(Debug, Default)]
pub struct InstallRoots {
    pub npm: Option<String>,
    pub pnpm: Option<String>,
    pub bun: Option<String>,
    pub brew: Option<String>,
    pub local_app_data: Option<String>,
    /// Volta's home, set only when its package image for this engine exists, since
    /// its bin links name the shim and not the package.
    pub volta: Option<String>,
}

fn normalize(path: &str) -> String {
    let unified = path.replace('\\', "/");
    if cfg!(windows) {
        unified.to_lowercase()
    } else {
        unified
    }
}

fn under(path: &str, root: Option<&str>) -> bool {
    root.is_some_and(|root| {
        let root = normalize(root);
        path.starts_with(&format!("{}/", root.trim_end_matches('/')))
    })
}

/// Decides ownership from the binary's real path. Pure, so every installer is
/// testable on every OS.
pub fn plan_from_paths(
    real: &Path,
    command: &Path,
    spec: &PackageSpec,
    roots: &InstallRoots,
) -> (InstallerKind, Option<UpdatePlan>) {
    let path = normalize(&real.to_string_lossy());
    let package = format!("/{}/", spec.npm_package);

    if let Some(name) = brew_package(&path, spec)
        && under(&path, roots.brew.as_deref())
    {
        let mut args = vec!["upgrade".to_owned()];
        if path.to_lowercase().contains("/caskroom/") {
            args.push("--cask".to_owned());
        }
        args.push(name);
        return (
            InstallerKind::Homebrew,
            Some(UpdatePlan {
                installer: InstallerKind::Homebrew,
                program: "brew".into(),
                args,
                lock_key: "homebrew".into(),
            }),
        );
    }
    if is_vite_plus_shim(&path) || is_vite_plus_shim(&normalize(&command.to_string_lossy())) {
        return package_plan(
            InstallerKind::VitePlus,
            "vp",
            &["i", "-g", spec.npm_package],
        );
    }
    if roots.volta.is_some() {
        let latest = format!("{}@latest", spec.npm_package);
        return package_plan(InstallerKind::Volta, "volta", &["install", &latest]);
    }
    if is_yarn_global(&path) && path.contains(&package) {
        let latest = format!("{}@latest", spec.npm_package);
        return package_plan(InstallerKind::Yarn, "yarn", &["global", "add", &latest]);
    }
    if path.contains(&package) {
        let latest = format!("{}@latest", spec.npm_package);
        if under(&path, roots.bun.as_deref()) {
            return package_plan(InstallerKind::Bun, "bun", &["add", "-g", &latest]);
        }
        if under(&path, roots.pnpm.as_deref()) {
            return package_plan(InstallerKind::Pnpm, "pnpm", &["add", "-g", &latest]);
        }
        if under(&path, roots.npm.as_deref()) {
            return package_plan(InstallerKind::Npm, "npm", &["install", "-g", &latest]);
        }
    }
    if let Some(root) = roots.local_app_data.as_deref() {
        let packages = format!(
            "{}/microsoft/winget/packages/",
            normalize(root).trim_end_matches('/').to_lowercase()
        );
        if path.to_lowercase().starts_with(&packages)
            && let Some(id) = spec
                .winget_ids
                .iter()
                .find(|id| path.to_lowercase()[packages.len()..].starts_with(&id.to_lowercase()))
        {
            return package_plan(
                InstallerKind::Winget,
                "winget",
                &["upgrade", "--id", id, "--exact"],
            );
        }
    }
    if (spec.native_owner)(&path) || (spec.native_owner)(&normalize(&command.to_string_lossy())) {
        return (
            InstallerKind::SelfManaged,
            Some(UpdatePlan {
                installer: InstallerKind::SelfManaged,
                program: command.to_string_lossy().into_owned(),
                args: vec!["update".into()],
                lock_key: format!("native:{}", command.display()),
            }),
        );
    }
    (InstallerKind::Unknown, None)
}

/// Vite+ keeps its command shims in `<home>/bin`: `~/.vite-plus`, the XDG data
/// directory, or the local app-data folder on Windows.
fn is_vite_plus_shim(path: &str) -> bool {
    let path = path.to_lowercase();
    [
        "/.vite-plus/bin/",
        "/.local/share/vite-plus/bin/",
        "/appdata/local/vite-plus/bin/",
    ]
    .iter()
    .any(|marker| path.contains(marker))
}

/// Yarn classic installs globals under its `global` folder, beside or inside `data`.
fn is_yarn_global(path: &str) -> bool {
    let path = path.to_lowercase();
    path.contains("/yarn/global/node_modules/") || path.contains("/yarn/data/global/node_modules/")
}

/// Compares in lowercase, as `normalize` leaves a path on Windows.
fn brew_package(path: &str, spec: &PackageSpec) -> Option<String> {
    let path = path.to_lowercase();
    let rest = path
        .split_once("/cellar/")
        .or_else(|| path.split_once("/caskroom/"))?
        .1;
    let name = rest.split('/').next()?;
    spec.brew_names
        .iter()
        .find(|known| **known == name)
        .map(|known| (*known).to_owned())
}

fn package_plan(
    installer: InstallerKind,
    program: &str,
    args: &[&str],
) -> (InstallerKind, Option<UpdatePlan>) {
    (
        installer,
        Some(UpdatePlan {
            installer,
            program: program.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            lock_key: program.to_owned(),
        }),
    )
}

/// The same plan, asking for one exact version, when the owning installer can
/// install one. Homebrew and an engine's own updater only move to the newest
/// release, so they give `None` and the caller falls back to manual instructions.
pub fn pinned(plan: &UpdatePlan, version: &str) -> Option<UpdatePlan> {
    let plain = version.chars().next()?.is_ascii_digit()
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !plain {
        return None;
    }
    match plan.installer {
        InstallerKind::Npm
        | InstallerKind::Pnpm
        | InstallerKind::Bun
        | InstallerKind::Yarn
        | InstallerKind::Volta
        | InstallerKind::VitePlus => {
            let package = plan.args.last()?.strip_suffix("@latest")?;
            let mut args = plan.args.clone();
            *args.last_mut()? = format!("{package}@{version}");
            Some(UpdatePlan {
                args,
                ..plan.clone()
            })
        }
        InstallerKind::Winget => {
            let at = plan.args.iter().position(|arg| arg == "--exact")?;
            let mut args = plan.args.clone();
            args.splice(at..at, ["--version".to_owned(), version.to_owned()]);
            Some(UpdatePlan {
                args,
                ..plan.clone()
            })
        }
        _ => None,
    }
}

async fn tool_answer(program: &str, args: &[&str]) -> Option<String> {
    let command = resolve(program)?;
    let output = capture(&command, args, ROOT_TIMEOUT).await?;
    let answer = output.stdout.trim();
    (output.status == 0 && !answer.is_empty()).then(|| answer.to_owned())
}

/// Asks only the tools the path hints at, so a probe does not spawn every
/// package manager on the machine.
async fn install_roots(path: &str) -> InstallRoots {
    let mut roots = InstallRoots {
        local_app_data: std::env::var("LOCALAPPDATA").ok(),
        ..InstallRoots::default()
    };
    if path.contains("/node_modules/") {
        roots.npm = tool_answer("npm", &["root", "-g"]).await;
        if path.contains("/pnpm/") {
            roots.pnpm = tool_answer("pnpm", &["root", "-g"]).await;
        }
        if path.contains("/.bun/") {
            roots.bun = home_dir().map(|home| {
                home.join(".bun/install/global/node_modules")
                    .to_string_lossy()
                    .into_owned()
            });
        }
    }
    if path.contains("/Cellar/") || path.contains("/Caskroom/") {
        roots.brew = tool_answer("brew", &["--prefix"]).await;
    }
    roots
}

/// Volta's home when the command is its shim and its package image holds the engine.
fn volta_home(real: &Path, command: &Path, spec: &PackageSpec) -> Option<String> {
    let name = real.file_stem()?.to_string_lossy().to_lowercase();
    if name != "volta-shim" {
        return None;
    }
    let home = command.parent()?.parent()?;
    let image = spec.npm_package.split('/').fold(
        home.join("tools").join("image").join("packages"),
        |dir, part| dir.join(part),
    );
    image.is_dir().then(|| home.to_string_lossy().into_owned())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub async fn plan_update(probe: &EngineProbe, spec: &PackageSpec) -> Option<UpdatePlan> {
    detect(probe, spec).await.1
}

pub async fn detect(
    probe: &EngineProbe,
    spec: &PackageSpec,
) -> (InstallerKind, Option<UpdatePlan>) {
    let Some(command) = &probe.path else {
        return (InstallerKind::Unknown, None);
    };
    let real = real_path(command);
    let mut roots = install_roots(&normalize(&real.to_string_lossy())).await;
    roots.volta = volta_home(&real, command, spec);
    plan_from_paths(&real, command, spec, &roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(
        real: &str,
        spec: &PackageSpec,
        roots: &InstallRoots,
    ) -> (InstallerKind, Option<String>) {
        let (kind, plan) = plan_from_paths(Path::new(real), Path::new(real), spec, roots);
        (kind, plan.map(|plan| plan.display()))
    }

    #[test]
    fn npm_needs_the_real_path_under_npm_root() {
        let real = "/usr/local/n/versions/node/22.16.0/lib/node_modules/@openai/codex/bin/codex.js";
        let roots = InstallRoots {
            npm: Some("/usr/local/n/versions/node/22.16.0/lib/node_modules".into()),
            ..InstallRoots::default()
        };
        assert_eq!(
            plan(real, &CODEX, &roots),
            (
                InstallerKind::Npm,
                Some("npm install -g @openai/codex@latest".into())
            )
        );
        // The same path with no proof from npm stays manual.
        assert_eq!(
            plan(real, &CODEX, &InstallRoots::default()),
            (InstallerKind::Unknown, None)
        );
    }

    #[test]
    fn a_vendored_copy_outside_the_global_root_is_not_owned() {
        let real = "/work/app/node_modules/@openai/codex/bin/codex.js";
        let roots = InstallRoots {
            npm: Some("/usr/local/lib/node_modules".into()),
            ..InstallRoots::default()
        };
        assert_eq!(plan(real, &CODEX, &roots).0, InstallerKind::Unknown);
    }

    #[test]
    fn homebrew_needs_a_known_name_under_its_prefix() {
        let roots = InstallRoots {
            brew: Some("/opt/homebrew".into()),
            ..InstallRoots::default()
        };
        assert_eq!(
            plan(
                "/opt/homebrew/Caskroom/claude-code/2.1/claude",
                &CLAUDE,
                &roots
            ),
            (
                InstallerKind::Homebrew,
                Some("brew upgrade --cask claude-code".into())
            )
        );
        assert_eq!(
            plan("/opt/homebrew/Cellar/codex/0.1/bin/codex", &CODEX, &roots),
            (InstallerKind::Homebrew, Some("brew upgrade codex".into()))
        );
        assert_eq!(
            plan("/opt/homebrew/Cellar/other/0.1/bin/codex", &CODEX, &roots).0,
            InstallerKind::Unknown
        );
    }

    #[test]
    fn pnpm_and_bun_use_their_own_roots() {
        let roots = InstallRoots {
            pnpm: Some("/home/a/.local/share/pnpm/global/5/node_modules".into()),
            bun: Some("/home/a/.bun/install/global/node_modules".into()),
            ..InstallRoots::default()
        };
        assert_eq!(
            plan(
                "/home/a/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
                &CODEX,
                &roots
            )
            .0,
            InstallerKind::Pnpm
        );
        assert_eq!(
            plan(
                "/home/a/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
                &CODEX,
                &roots
            )
            .0,
            InstallerKind::Bun
        );
    }

    #[test]
    fn winget_reads_the_package_folder() {
        let roots = InstallRoots {
            local_app_data: Some(r"C:\Users\a\AppData\Local".into()),
            ..InstallRoots::default()
        };
        let real = r"C:\Users\a\AppData\Local\Microsoft\WinGet\Packages\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\codex.exe";
        assert_eq!(plan(real, &CODEX, &roots).0, InstallerKind::Winget);
    }

    #[test]
    fn native_updater_needs_a_provable_layout() {
        let roots = InstallRoots::default();
        assert_eq!(
            plan(
                "/home/a/.local/share/claude/versions/2.1.0",
                &CLAUDE,
                &roots
            )
            .0,
            InstallerKind::SelfManaged
        );
        assert_eq!(
            plan(
                "/home/a/.codex/packages/standalone/releases/x/codex",
                &CODEX,
                &roots
            )
            .0,
            InstallerKind::SelfManaged
        );
        assert_eq!(
            plan("/usr/bin/claude", &CLAUDE, &roots),
            (InstallerKind::Unknown, None)
        );
    }

    #[test]
    fn yarn_vite_plus_and_volta_run_their_own_updates() {
        let roots = InstallRoots::default();
        assert_eq!(
            plan(
                "/home/a/.config/yarn/global/node_modules/@openai/codex/bin/codex.js",
                &CODEX,
                &roots
            ),
            (
                InstallerKind::Yarn,
                Some("yarn global add @openai/codex@latest".into())
            )
        );
        assert_eq!(
            plan(
                "/home/a/.local/share/yarn/data/global/node_modules/@openai/codex/bin/codex.js",
                &CODEX,
                &roots
            )
            .0,
            InstallerKind::Yarn
        );
        // A yarn folder that does not hold the engine proves nothing.
        assert_eq!(
            plan(
                "/home/a/.config/yarn/global/node_modules/other/bin/codex.js",
                &CODEX,
                &roots
            ),
            (InstallerKind::Unknown, None)
        );
        for home in ["/home/a/.vite-plus", "/home/a/.local/share/vite-plus"] {
            assert_eq!(
                plan(&format!("{home}/bin/codex"), &CODEX, &roots),
                (
                    InstallerKind::VitePlus,
                    Some("vp i -g @openai/codex".into())
                )
            );
        }
        // The shim is a link to the tool, so the command path alone proves it.
        let (kind, _) = plan_from_paths(
            Path::new("/home/a/.vite-plus/current/bin/vp"),
            Path::new("/home/a/.vite-plus/bin/codex"),
            &CODEX,
            &roots,
        );
        assert_eq!(kind, InstallerKind::VitePlus);
        let volta = InstallRoots {
            volta: Some("/home/a/.volta".into()),
            ..InstallRoots::default()
        };
        assert_eq!(
            plan("/home/a/.volta/bin/volta-shim", &CODEX, &volta),
            (
                InstallerKind::Volta,
                Some("volta install @openai/codex@latest".into())
            )
        );
        // Without the package image a Volta shim stays manual.
        assert_eq!(
            plan("/home/a/.volta/bin/volta-shim", &CODEX, &roots),
            (InstallerKind::Unknown, None)
        );
    }

    #[test]
    fn mise_installs_are_left_to_mise() {
        let roots = InstallRoots::default();
        for real in [
            "/home/a/.local/share/mise/installs/node/22/lib/node_modules/@openai/codex/bin/codex.js",
            "/home/a/.local/share/mise/shims/codex",
        ] {
            assert_eq!(
                plan(real, &CODEX, &roots),
                (InstallerKind::Unknown, None),
                "{real}"
            );
        }
    }

    #[test]
    fn volta_ownership_is_read_from_the_package_image() {
        let dir = std::env::temp_dir().join(format!("orbyn-volta-{}", crate::util::new_id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("volta-shim");
        std::fs::write(&shim, b"").unwrap();
        let command = bin.join("codex");
        assert_eq!(
            volta_home(&shim, &command, &CODEX),
            None,
            "no package image yet"
        );
        std::fs::create_dir_all(dir.join("tools/image/packages/@openai/codex")).unwrap();
        assert_eq!(
            volta_home(&shim, &command, &CODEX),
            Some(dir.to_string_lossy().into_owned())
        );
        assert_eq!(
            volta_home(&command, &command, &CODEX),
            None,
            "only the shim counts"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_pinned_plan_uses_the_installer_that_owns_the_binary() {
        let roots = InstallRoots {
            npm: Some("/usr/local/lib/node_modules".into()),
            pnpm: Some("/home/a/.local/share/pnpm/global/5/node_modules".into()),
            bun: Some("/home/a/.bun/install/global/node_modules".into()),
            brew: Some("/opt/homebrew".into()),
            ..InstallRoots::default()
        };
        let npm = plan_from_paths(
            Path::new("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"),
            Path::new("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"),
            &CODEX,
            &roots,
        )
        .1
        .unwrap();
        assert_eq!(
            pinned(&npm, "0.166.0").unwrap().display(),
            "npm install -g @openai/codex@0.166.0"
        );
        let pnpm = plan_from_paths(
            Path::new("/home/a/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js"),
            Path::new("/home/a/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js"),
            &CODEX,
            &roots,
        )
        .1
        .unwrap();
        assert_eq!(
            pinned(&pnpm, "1.2.3").unwrap().display(),
            "pnpm add -g @openai/codex@1.2.3"
        );
        let winget = UpdatePlan {
            installer: InstallerKind::Winget,
            program: "winget".into(),
            args: ["upgrade", "--id", "OpenAI.Codex", "--exact"]
                .iter()
                .map(|arg| (*arg).to_owned())
                .collect(),
            lock_key: "winget".into(),
        };
        assert_eq!(
            pinned(&winget, "0.166.0").unwrap().display(),
            "winget upgrade --id OpenAI.Codex --version 0.166.0 --exact"
        );

        // An installer that only moves to the newest release cannot pin a version.
        for real in [
            "/opt/homebrew/Cellar/codex/0.1/bin/codex",
            "/home/a/.codex/packages/standalone/releases/x/codex",
        ] {
            let (_, brew) = plan_from_paths(Path::new(real), Path::new(real), &CODEX, &roots);
            assert!(pinned(&brew.unwrap(), "0.166.0").is_none(), "{real}");
        }
        // A version that is not a plain version never reaches an installer.
        for version in ["", "--force", "latest", "0.166.0; rm -rf /"] {
            assert!(pinned(&npm, version).is_none(), "{version}");
        }
    }
}
