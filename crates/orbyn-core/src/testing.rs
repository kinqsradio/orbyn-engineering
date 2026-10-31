//! Helpers shared by unit tests.

use std::path::{Path, PathBuf};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("orbyn-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&path).unwrap();
        // Temp folders sit behind a symlink on macOS, and the workspace refuses those.
        Self(crate::util::canonicalize(&path).unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs git and panics on failure, for arranging repositories in tests.
pub fn run_git(cwd: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A minimal valid skills library with one skill and its host links.
pub fn library(root: &Path) -> PathBuf {
    std::fs::create_dir_all(root.join("skills/how")).unwrap();
    std::fs::write(root.join("AGENTS.md"), "shared policy\n").unwrap();
    std::fs::write(root.join(".gitignore"), "repo/\n").unwrap();
    std::fs::write(
        root.join("skills/catalog.json"),
        r#"{"skills":[{"name":"how","category":"Engineering practice"},
            {"name":"social-content","category":"Social content and visuals"}]}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("skills/how/SKILL.md"),
        "---\nname: how\ndescription: \"Trace behavior\"\n---\n\n# how\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("skills/social-content")).unwrap();
    std::fs::write(
        root.join("skills/social-content/SKILL.md"),
        "---\nname: social-content\ndescription: \"Posts\"\n---\n",
    )
    .unwrap();
    for host in [".claude", ".agents"] {
        let links = root.join(host).join("skills");
        std::fs::create_dir_all(&links).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("../../skills/how", links.join("how")).unwrap();
    }
    run_git(root, &["init", "-q", "-b", "main"]);
    run_git(root, &["config", "user.email", "t@example.com"]);
    run_git(root, &["config", "user.name", "T"]);
    run_git(root, &["add", "."]);
    run_git(root, &["commit", "-q", "-m", "library"]);
    crate::util::canonicalize(root).unwrap()
}
