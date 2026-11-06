//! The script a Claude Code workflow runs, for display beside its tool call. An
//! inline script is already in the call's input; otherwise the CLI's reported
//! `scriptPath` is read, only when it is a `.js` file inside the CLI's own
//! `projects` or `workflows` folder or the thread's checkout. Nothing else under
//! the CLI's config is read, so its login files stay out of reach.

use std::io::Read;
use std::path::{Path, PathBuf};

use orbyn_contracts::WorkflowScript;
use serde_json::Value;

use crate::app::Core;
use crate::driver::workflow_item_id;
use crate::error::{CoreError, Result};
use crate::util::canonicalize;

/// More than a workflow script needs; a longer one is cut for display.
pub const MAX_SCRIPT_BYTES: usize = 256 * 1024;
const WORKFLOW_TOOL: &str = "Workflow";

impl Core {
    pub fn workflow_script(&self, thread_id: &str, tool_call_id: &str) -> Result<WorkflowScript> {
        let (_, scope) = self.file_scope(thread_id)?;
        let call = self
            .store
            .item(thread_id, tool_call_id)
            .map_err(|_| CoreError::NotFound("workflow".into()))?;
        if call.kind != "tool_use"
            || call.raw.get("name").and_then(Value::as_str) != Some(WORKFLOW_TOOL)
        {
            return Err(CoreError::NotFound("workflow".into()));
        }
        let input = call.raw.get("input").cloned().unwrap_or(Value::Null);
        let reported = self
            .store
            .item(thread_id, &workflow_item_id(tool_call_id))
            .ok()
            .and_then(|item| text(&item.raw, "scriptPath"));
        let path = reported.or_else(|| text(&input, "scriptPath"));
        if let Some(script) = text(&input, "script") {
            let (contents, truncated) = cap(script.into_bytes());
            return Ok(WorkflowScript {
                path,
                contents,
                truncated,
            });
        }
        let Some(path) = path else {
            return Err(CoreError::NotFound("workflow script".into()));
        };
        let roots = script_roots(&scope.engine_cwd, &scope.checkout);
        let (contents, truncated) = read_contained(Path::new(&path), &roots)?;
        Ok(WorkflowScript {
            path: Some(path),
            contents,
            truncated,
        })
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The CLI's own script folders, and the checkout an agent can write a script in.
fn script_roots(engine_cwd: &Path, checkout: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(config) = crate::claude_skills::config_dir(engine_cwd) {
        roots.push(config.join("projects"));
        roots.push(config.join("workflows"));
    }
    roots.push(checkout.to_path_buf());
    roots
        .iter()
        .filter_map(|root| canonicalize(root).ok())
        .collect()
}

/// Reads a `.js` regular file whose resolved path is inside one of `roots`.
pub(crate) fn read_contained(path: &Path, roots: &[PathBuf]) -> Result<(String, bool)> {
    let refused =
        || CoreError::Invalid("That workflow script is outside the folders Orbyn reads.".into());
    if !path.is_absolute() {
        return Err(refused());
    }
    let resolved = canonicalize(path).map_err(|_| CoreError::NotFound("workflow script".into()))?;
    let is_js = |path: &Path| {
        path.extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("js"))
    };
    if !is_js(path) || !is_js(&resolved) || !roots.iter().any(|root| resolved.starts_with(root)) {
        return Err(refused());
    }
    let file = std::fs::File::open(&resolved)
        .map_err(|_| CoreError::NotFound("workflow script".into()))?;
    if !file.metadata()?.is_file() {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SCRIPT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(cap(bytes))
}

fn cap(mut bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_SCRIPT_BYTES;
    bytes.truncate(MAX_SCRIPT_BYTES);
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            // Cut at the last whole character, then show anything else as replaced.
            let valid = error.utf8_error().valid_up_to();
            let bytes = error.into_bytes();
            let tail = String::from_utf8_lossy(&bytes[valid..]);
            let tail = if truncated && tail.chars().all(|c| c == '\u{fffd}') {
                String::new()
            } else {
                tail.into_owned()
            };
            format!("{}{tail}", String::from_utf8_lossy(&bytes[..valid]))
        }
    };
    (text, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn dir() -> TempDir {
        TempDir::new()
    }

    #[test]
    fn reads_a_script_inside_a_root() {
        let root = dir();
        let script = root.path().join("flow.js");
        std::fs::write(&script, "export const meta = {}\n").unwrap();
        let roots = vec![canonicalize(root.path()).unwrap()];
        let (contents, truncated) = read_contained(&script, &roots).unwrap();
        assert_eq!(contents, "export const meta = {}\n");
        assert!(!truncated);
    }

    #[test]
    fn refuses_other_files_and_folders() {
        let root = dir();
        let outside = dir();
        let roots = vec![canonicalize(root.path()).unwrap()];
        let elsewhere = outside.path().join("flow.js");
        std::fs::write(&elsewhere, "x").unwrap();
        let json = root.path().join(".credentials.json");
        std::fs::write(&json, "{}").unwrap();
        assert!(read_contained(&elsewhere, &roots).is_err());
        assert!(read_contained(&json, &roots).is_err());
        assert!(read_contained(Path::new("flow.js"), &roots).is_err());
        let folder = root.path().join("dir.js");
        std::fs::create_dir(&folder).unwrap();
        assert!(read_contained(&folder, &roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_link_that_leaves_the_root() {
        let root = dir();
        let outside = dir();
        let target = outside.path().join("secret.js");
        std::fs::write(&target, "x").unwrap();
        let link = root.path().join("flow.js");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let roots = vec![canonicalize(root.path()).unwrap()];
        assert!(read_contained(&link, &roots).is_err());
    }

    #[test]
    fn cuts_a_long_script() {
        let root = dir();
        let script = root.path().join("long.js");
        std::fs::write(&script, "é".repeat(MAX_SCRIPT_BYTES)).unwrap();
        let roots = vec![canonicalize(root.path()).unwrap()];
        let (contents, truncated) = read_contained(&script, &roots).unwrap();
        assert!(truncated);
        assert!(contents.len() <= MAX_SCRIPT_BYTES);
        assert!(!contents.contains('\u{fffd}'));
    }
}
