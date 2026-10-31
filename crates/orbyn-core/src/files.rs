//! Reading and editing a thread's checkout. Every path passes the same write
//! scope engines do, so `..` and symlinks cannot leave the checkout, and Git's
//! own folder is out of reach. An edit names the revision it started from; a file
//! that moved on since then is reported, never overwritten.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use orbyn_contracts::{
    EditorInfo, FileContent, FileEntry, OpenInEditor, SearchHit, Thread, WriteFile,
};
use serde_json::json;

use crate::app::Core;
use crate::approvals::WriteScope;
use crate::error::{CoreError, Result};
use crate::git::{git, git_raw};
use crate::process::resolve;
use crate::store::AuditRecord;
use crate::util::{new_id, sha256_hex};

const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HITS: usize = 200;
const MAX_LIST: usize = 5_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchStyle {
    /// `editor file:line:col`.
    Path,
    /// `editor --goto file:line:col`.
    Goto,
    /// `editor --line N --column C file`.
    LineColumn,
}

struct Editor {
    id: &'static str,
    name: &'static str,
    /// Tried in order; the first on PATH wins.
    commands: &'static [&'static str],
    args: &'static [&'static str],
    style: LaunchStyle,
}

const fn editor(
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    style: LaunchStyle,
) -> Editor {
    Editor {
        id,
        name,
        commands,
        args: &[],
        style,
    }
}

const FILE_MANAGER: &str = "file_manager";

/// Only these can be launched, so a request cannot name an arbitrary program.
const EDITORS: &[Editor] = &[
    Editor {
        args: &["--classic"],
        ..editor("cursor", "Cursor", &["cursor"], LaunchStyle::Goto)
    },
    editor("trae", "Trae", &["trae"], LaunchStyle::Goto),
    Editor {
        args: &["ide"],
        ..editor("kiro", "Kiro", &["kiro"], LaunchStyle::Goto)
    },
    editor("vscode", "VS Code", &["code"], LaunchStyle::Goto),
    editor(
        "vscode-insiders",
        "VS Code Insiders",
        &["code-insiders"],
        LaunchStyle::Goto,
    ),
    editor("vscodium", "VSCodium", &["codium"], LaunchStyle::Goto),
    editor("windsurf", "Windsurf", &["windsurf"], LaunchStyle::Goto),
    editor("zed", "Zed", &["zed", "zeditor"], LaunchStyle::Path),
    editor(
        "antigravity",
        "Antigravity",
        &["antigravity-ide", "agy-ide"],
        LaunchStyle::Goto,
    ),
    editor("sublime", "Sublime Text", &["subl"], LaunchStyle::Path),
    editor("idea", "IntelliJ IDEA", &["idea"], LaunchStyle::LineColumn),
    editor("pycharm", "PyCharm", &["pycharm"], LaunchStyle::LineColumn),
    editor(
        "webstorm",
        "WebStorm",
        &["webstorm"],
        LaunchStyle::LineColumn,
    ),
    editor("goland", "GoLand", &["goland"], LaunchStyle::LineColumn),
    editor(
        "rustrover",
        "RustRover",
        &["rustrover"],
        LaunchStyle::LineColumn,
    ),
    editor("clion", "CLion", &["clion"], LaunchStyle::LineColumn),
    editor("rider", "Rider", &["rider"], LaunchStyle::LineColumn),
    editor(
        "rubymine",
        "RubyMine",
        &["rubymine"],
        LaunchStyle::LineColumn,
    ),
    editor(
        "phpstorm",
        "PhpStorm",
        &["phpstorm"],
        LaunchStyle::LineColumn,
    ),
    editor(
        "datagrip",
        "DataGrip",
        &["datagrip"],
        LaunchStyle::LineColumn,
    ),
];

fn style_name(style: LaunchStyle) -> &'static str {
    match style {
        LaunchStyle::Path => "path",
        LaunchStyle::Goto => "goto",
        LaunchStyle::LineColumn => "line_column",
    }
}

fn program_of(editor: &Editor) -> Option<crate::process::ResolvedCommand> {
    editor.commands.iter().find_map(|name| resolve(name))
}

/// The system file manager's name for this platform.
fn file_manager_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "Finder"
    } else if cfg!(windows) {
        "File Explorer"
    } else {
        "Files"
    }
}

pub fn installed_editors() -> Vec<EditorInfo> {
    EDITORS
        .iter()
        .filter(|editor| program_of(editor).is_some())
        .map(|editor| EditorInfo {
            id: editor.id.to_owned(),
            name: editor.name.to_owned(),
            launch_style: style_name(editor.style).to_owned(),
            file_manager: false,
        })
        .chain(std::iter::once(EditorInfo {
            id: FILE_MANAGER.to_owned(),
            name: file_manager_name().to_owned(),
            launch_style: String::new(),
            file_manager: true,
        }))
        .collect()
}

/// The arguments that open `file` at a position, in this editor's own form.
fn launch_args(
    editor: &Editor,
    file: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = editor.args.iter().map(OsString::from).collect();
    let target = |suffix: String| {
        let mut full = file.as_os_str().to_owned();
        full.push(suffix);
        full
    };
    let position = match (line, column) {
        (Some(line), Some(column)) => format!(":{line}:{column}"),
        (Some(line), None) => format!(":{line}"),
        _ => String::new(),
    };
    match (editor.style, line) {
        (_, None) => args.push(file.into()),
        (LaunchStyle::Path, Some(_)) => args.push(target(position)),
        (LaunchStyle::Goto, Some(_)) => {
            args.push("--goto".into());
            args.push(target(position));
        }
        (LaunchStyle::LineColumn, Some(line)) => {
            args.push("--line".into());
            args.push(line.to_string().into());
            if let Some(column) = column {
                args.push("--column".into());
                args.push(column.to_string().into());
            }
            args.push(file.into());
        }
    }
    args
}

/// Shows a file in the system file manager.
fn reveal_command(file: &Path) -> (&'static str, Vec<OsString>) {
    if cfg!(target_os = "macos") {
        ("open", vec!["-R".into(), file.into()])
    } else if cfg!(windows) {
        let mut select = OsString::from("/select,");
        select.push(file);
        ("explorer", vec![select])
    } else {
        let folder = file.parent().unwrap_or(file);
        ("xdg-open", vec![folder.into()])
    }
}

fn scope_of(root: &Path, thread: &Thread) -> WriteScope {
    let checkout = PathBuf::from(&thread.cwd);
    WriteScope {
        excluded: if checkout == root {
            vec![root.join("repo")]
        } else {
            Vec::new()
        },
        engine_cwd: checkout.clone(),
        checkout,
    }
}

/// Resolves a relative path inside the checkout, or refuses it.
fn inside(scope: &WriteScope, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    let in_git = relative
        .components()
        .any(|part| matches!(part, Component::Normal(name) if name == ".git"));
    if relative.is_absolute() || in_git || !scope.permits(path) {
        return Err(CoreError::Invalid(
            "That path is outside this checkout.".into(),
        ));
    }
    Ok(scope.checkout.join(relative))
}

fn revision_of(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

impl Core {
    /// A thread's checkout, gated on trust like any other work in the folder.
    fn file_scope(&self, thread_id: &str) -> Result<(Thread, WriteScope)> {
        let thread = self.store.thread(thread_id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let scope = scope_of(&self.workspace.root()?, &thread);
        Ok((thread, scope))
    }

    pub async fn list_files(&self, thread_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        let (_, scope) = self.file_scope(thread_id)?;
        let dir = if path.is_empty() {
            scope.checkout.clone()
        } else {
            inside(&scope, path)?
        };
        let reader = std::fs::read_dir(&dir).map_err(|_| CoreError::NotFound("folder".into()))?;
        let mut names = Vec::new();
        let mut entries = Vec::new();
        for entry in reader.flatten().take(MAX_LIST) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let relative = if path.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", path.trim_end_matches('/'))
            };
            // A symlink is listed as itself and never followed.
            let meta = entry.metadata()?;
            names.push(relative.clone());
            entries.push(FileEntry {
                name,
                path: relative,
                is_dir: meta.is_dir(),
                size: meta.len(),
                ignored: false,
            });
        }
        let ignored = ignored_among(&scope.checkout, &names).await;
        for entry in &mut entries {
            entry.ignored = ignored.contains(&entry.path);
        }
        entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
        Ok(entries)
    }

    pub async fn ignored_files(&self, thread_id: &str) -> Result<Vec<String>> {
        let (_, scope) = self.file_scope(thread_id)?;
        let listing = git(
            &scope.checkout,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        )
        .await?;
        Ok(listing
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .take(MAX_LIST)
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect())
    }

    pub async fn read_file(&self, thread_id: &str, path: &str) -> Result<FileContent> {
        let (_, scope) = self.file_scope(thread_id)?;
        let full = inside(&scope, path)?;
        let meta = std::fs::metadata(&full).map_err(|_| CoreError::NotFound("file".into()))?;
        if !meta.is_file() {
            return Err(CoreError::Invalid("That path is not a file.".into()));
        }
        let size = meta.len();
        if size > MAX_READ_BYTES {
            return Ok(FileContent {
                path: path.to_owned(),
                content: String::new(),
                revision: String::new(),
                size,
                binary: false,
                truncated: true,
            });
        }
        let bytes = std::fs::read(&full)?;
        let revision = revision_of(&bytes);
        let text = String::from_utf8(bytes);
        let binary = text.is_err();
        Ok(FileContent {
            path: path.to_owned(),
            content: text.unwrap_or_default(),
            revision,
            size,
            binary,
            truncated: false,
        })
    }

    /// Saves an edit if the file is still what the editor started from. The new
    /// bytes reach the file by rename, so a reader never sees half a save.
    pub async fn write_file(
        &self,
        thread_id: &str,
        request: &WriteFile,
        actor: &str,
    ) -> Result<FileContent> {
        let (thread, scope) = self.file_scope(thread_id)?;
        let full = inside(&scope, &request.path)?;
        let current = match std::fs::read(&full) {
            Ok(bytes) => Some(revision_of(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if current != request.base_revision {
            return Err(CoreError::FileConflict { revision: current });
        }
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "file.write".into(),
            target: request.path.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread.id.clone()),
            run_id: None,
            detail: json!({ "bytes": request.content.len() }),
        })?;
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = full.with_file_name(format!(".orbyn-save-{}", new_id()));
        std::fs::write(&partial, &request.content)?;
        if let Ok(meta) = std::fs::metadata(&full) {
            std::fs::set_permissions(&partial, meta.permissions())?;
        }
        if let Err(error) = std::fs::rename(&partial, &full) {
            let _ = std::fs::remove_file(&partial);
            return Err(error.into());
        }
        self.read_file(thread_id, &request.path).await
    }

    /// File names, or lines of content, matching `query`. Content search covers
    /// untracked files and skips binary and ignored ones.
    pub async fn search_files(
        &self,
        thread_id: &str,
        query: &str,
        content: bool,
    ) -> Result<Vec<SearchHit>> {
        let (_, scope) = self.file_scope(thread_id)?;
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if !content {
            let needle = query.to_lowercase();
            let listing = git(
                &scope.checkout,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
            )
            .await?;
            return Ok(listing
                .split(|byte| *byte == 0)
                .map(|path| String::from_utf8_lossy(path).into_owned())
                .filter(|path| !path.is_empty() && path.to_lowercase().contains(&needle))
                .take(MAX_HITS)
                .map(|path| SearchHit {
                    path,
                    line: 0,
                    text: String::new(),
                })
                .collect());
        }
        // `grep` exits 1 for no matches, which is an answer and not a failure.
        let output = git_raw(
            &scope.checkout,
            &[
                "grep",
                "-n",
                "-I",
                "-z",
                "-F",
                "-i",
                "--untracked",
                "-e",
                query,
            ],
        )
        .await?;
        Ok(parse_grep(&output.stdout))
    }

    pub async fn open_in_editor(
        &self,
        thread_id: &str,
        request: &OpenInEditor,
        actor: &str,
    ) -> Result<()> {
        let (thread, scope) = self.file_scope(thread_id)?;
        let full = inside(&scope, &request.path)?;
        if request.column.is_some() && request.line.is_none()
            || request.line == Some(0)
            || request.column == Some(0)
        {
            return Err(CoreError::Invalid(
                "Lines and columns start at 1, and a column needs a line.".into(),
            ));
        }
        let (command, args) = if request.editor == FILE_MANAGER {
            let (program, args) = reveal_command(&full);
            let command = resolve(program)
                .ok_or_else(|| CoreError::Invalid("No file manager was found.".into()))?;
            (command, args)
        } else {
            let editor = EDITORS
                .iter()
                .find(|editor| editor.id == request.editor)
                .ok_or_else(|| CoreError::Invalid("Choose a known editor.".into()))?;
            let command = program_of(editor)
                .ok_or_else(|| CoreError::Invalid("That editor is not installed.".into()))?;
            let args = launch_args(editor, &full, request.line, request.column);
            (command, args)
        };
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "file.open".into(),
            target: request.path.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread.id),
            run_id: None,
            detail: json!({ "editor": request.editor, "line": request.line }),
        })?;
        tokio::process::Command::new(&command.program)
            .args(&command.prefix)
            .args(&args)
            .current_dir(&scope.checkout)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }
}

/// The subset of `names` the repository ignores.
async fn ignored_among(checkout: &Path, names: &[String]) -> Vec<String> {
    let mut found = Vec::new();
    for chunk in names.chunks(200) {
        let mut args = vec!["check-ignore", "--"];
        args.extend(chunk.iter().map(String::as_str));
        if let Ok(output) = git_raw(checkout, &args).await {
            found.extend(
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::to_owned),
            );
        }
    }
    found
}

/// `git grep -n -z`: path NUL line NUL text, one match per line.
fn parse_grep(output: &[u8]) -> Vec<SearchHit> {
    output
        .split(|byte| *byte == b'\n')
        .filter_map(|record| {
            let mut fields = record.splitn(3, |byte| *byte == 0);
            let path = String::from_utf8_lossy(fields.next()?).into_owned();
            let line = String::from_utf8_lossy(fields.next()?).parse().ok()?;
            let text = String::from_utf8_lossy(fields.next()?).into_owned();
            Some(SearchHit { path, line, text })
        })
        .take(MAX_HITS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grep_fields_keep_colons_in_paths_and_text() {
        let hits = parse_grep(b"a:b.rs\x007\x00let x: u8\nc.rs\x001\x00y\n");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "a:b.rs");
        assert_eq!(hits[0].line, 7);
        assert_eq!(hits[0].text, "let x: u8");
    }

    #[test]
    fn git_metadata_is_out_of_reach() {
        let dir = crate::testing::TempDir::new();
        let scope = WriteScope {
            checkout: dir.path().to_path_buf(),
            engine_cwd: dir.path().to_path_buf(),
            excluded: Vec::new(),
        };
        for bad in [".git/config", "src/.git/hooks/x", "/etc/hosts", "../x"] {
            assert!(inside(&scope, bad).is_err(), "{bad}");
        }
        assert!(inside(&scope, "src/a.rs").is_ok());
    }
}
