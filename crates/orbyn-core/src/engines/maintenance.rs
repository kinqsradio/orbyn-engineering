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
    let roots = install_roots(&normalize(&real.to_string_lossy())).await;
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
}
