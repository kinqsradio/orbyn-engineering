//! Passive registered-project image search. Ignore rules are parsed as checked
//! local data, without running Git or reading user-wide configuration.
use crate::{
    app::Core,
    error::{CoreError, Result},
    project_icons::{ImageScope, media_type},
};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use orbyn_contracts::{ProjectImageCandidate, ProjectImageSearchResult, SearchProjectImages};
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::{cmp::Reverse, collections::BTreeMap};

const MAX_VISITS: usize = 20_000;
const MAX_DEPTH: usize = 48;
const MAX_RESULTS: usize = 200;
const INDEX_BUDGET: Duration = Duration::from_secs(3);

pub(crate) fn validate_hint(path: &str) -> Result<()> {
    let invalid = || CoreError::Invalid("That path is outside this checkout.".into());
    if path.is_empty()
        || path.len() > 8192
        || path.contains('\\')
        || path.contains('\0')
        || path.as_bytes().get(1) == Some(&b':')
        || Path::new(path).is_absolute()
        || Path::new(path).components().any(|c| match c {
            Component::Normal(name) => name.to_string_lossy().eq_ignore_ascii_case(".git"),
            _ => true,
        })
        || media_type(path).is_none()
    {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Clone)]
struct Rules {
    git: Arc<Gitignore>,
    plain: Arc<Gitignore>,
}
fn ignored(rules: &[Rules], path: &Path, directory: bool) -> bool {
    for plain in [true, false] {
        for layer in rules.iter().rev() {
            let rule = if plain { &layer.plain } else { &layer.git };
            let matched = rule.matched_path_or_any_parents(path, directory);
            if !matched.is_none() {
                return matched.is_ignore();
            }
        }
    }
    false
}

async fn rules(scope: &mut ImageScope, directory: &Path) -> Result<Option<(Rules, bool)>> {
    let mut built = Vec::new();
    let mut partial = false;
    for name in [".gitignore", ".ignore"] {
        let file = directory.join(name);
        let mut builder = GitignoreBuilder::new(directory);
        if tokio::fs::symlink_metadata(&file).await.is_ok() {
            let relative = file
                .strip_prefix(scope.root())
                .map_err(|_| CoreError::StaleOwner)?;
            let Some(relative) = relative.to_str() else {
                return Ok(None);
            };
            let Some(text) = scope.text(&relative.replace('\\', "/")).await? else {
                return Ok(None);
            };
            for (number, line) in text.lines().enumerate() {
                let line = if number == 0 {
                    line.trim_start_matches('\u{feff}')
                } else {
                    line
                };
                if builder.add_line(Some(file.clone()), line).is_err() {
                    partial = true;
                }
            }
        }
        let Ok(matcher) = builder.build() else {
            return Ok(None);
        };
        built.push(Arc::new(matcher));
    }
    Ok(Some((
        Rules {
            git: built.remove(0),
            plain: built.remove(0),
        },
        partial,
    )))
}

async fn enumerate(scope: &mut ImageScope) -> Result<(Vec<ProjectImageCandidate>, bool)> {
    let deadline = Instant::now() + INDEX_BUDGET;
    let mut pending = vec![(scope.root().to_owned(), Vec::<Rules>::new(), 0)];
    let mut result = Vec::new();
    let mut visits = 0;
    let mut truncated = false;
    while let Some((directory, mut inherited, depth)) = pending.pop() {
        if Instant::now() >= deadline || visits >= MAX_VISITS {
            truncated = true;
            break;
        }
        if !scope.contains_directory(&directory) {
            continue;
        }
        let Some((local, partial)) = rules(scope, &directory).await? else {
            truncated = true;
            continue;
        };
        truncated |= partial;
        inherited.push(local);
        let Ok(mut reader) = tokio::fs::read_dir(&directory).await else {
            truncated = true;
            continue;
        };
        let mut entries = Vec::new();
        loop {
            if Instant::now() >= deadline || visits >= MAX_VISITS {
                truncated = true;
                break;
            }
            let Some(entry) = reader.next_entry().await? else {
                break;
            };
            visits += 1;
            entries.push(entry);
        }
        if !scope.contains_directory(&directory) {
            continue;
        }
        entries.sort_by_key(|entry| entry.file_name());
        let mut children = Vec::new();
        for entry in entries {
            if Instant::now() >= deadline {
                return Ok((result, true));
            }
            // Filesystem checks are bounded per entry; yield between them so a
            // cancelled request does not keep walking a wide directory.
            tokio::task::yield_now().await;
            if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
            {
                continue;
            }
            let file_type = match entry.file_type().await {
                Ok(kind) => kind,
                Err(_) => {
                    truncated = true;
                    continue;
                }
            };
            let path = entry.path();
            if ignored(&inherited, &path, file_type.is_dir()) {
                continue;
            }
            if file_type.is_dir() {
                if depth < MAX_DEPTH {
                    children.push((path, inherited.clone(), depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            let Some(relative) = path.strip_prefix(scope.root()).ok().and_then(Path::to_str) else {
                continue;
            };
            let relative = relative.replace('\\', "/");
            if validate_hint(&relative).is_err() {
                continue;
            }
            match scope.candidate_path(&relative) {
                Ok(Some(_)) => {}
                Ok(None) | Err(CoreError::FileTooLarge { .. }) => continue,
                Err(error) => return Err(error),
            }
            result.push(ProjectImageCandidate {
                path: relative,
                name: entry.file_name().to_string_lossy().into_owned(),
            });
        }
        pending.extend(children.into_iter().rev());
        tokio::task::yield_now().await;
    }
    Ok((result, truncated))
}

/// Independent matching policy: each word must appear in order, with gaps
/// allowed. Return gap count and first position as stable quality measures.
fn subsequence(text: &str, word: &str) -> Option<(usize, usize)> {
    let mut wanted = word.chars().peekable();
    let mut first = None;
    let mut matched = 0;
    for (position, ch) in text.chars().enumerate() {
        if wanted.peek() == Some(&ch) {
            first.get_or_insert(position);
            matched += 1;
            wanted.next();
            if wanted.peek().is_none() {
                let first = first?;
                return Some((position - first + 1 - matched, first));
            }
        }
    }
    None
}

#[derive(Eq, PartialEq, Ord, PartialOrd)]
struct MatchQuality {
    basename: Reverse<usize>,
    prefix: Reverse<usize>,
    contiguous: Reverse<usize>,
    gaps: usize,
    position: usize,
    length: usize,
}
fn match_quality(
    candidate: &ProjectImageCandidate,
    words: &[String],
    deadline: Instant,
) -> Option<MatchQuality> {
    let basename = candidate.name.to_lowercase();
    let path = candidate.path.to_lowercase();
    let mut quality = MatchQuality {
        basename: Reverse(0),
        prefix: Reverse(0),
        contiguous: Reverse(0),
        gaps: 0,
        position: 0,
        length: path.chars().count(),
    };
    for word in words {
        if Instant::now() >= deadline {
            return None;
        }
        let matched = if let Some(result) = subsequence(&basename, word) {
            quality.basename.0 += 1;
            if basename.starts_with(word) {
                quality.prefix.0 += 1;
            }
            if basename.contains(word) {
                quality.contiguous.0 += 1;
            }
            result
        } else {
            if path.starts_with(word) {
                quality.prefix.0 += 1;
            }
            if path.contains(word) {
                quality.contiguous.0 += 1;
            }
            subsequence(&path, word)?
        };
        quality.gaps += matched.0;
        quality.position += matched.1;
    }
    Some(quality)
}

async fn ranked(
    entries: Vec<ProjectImageCandidate>,
    query: &str,
    history: &BTreeMap<String, (i64, i64)>,
) -> (Vec<ProjectImageCandidate>, bool) {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let deadline = Instant::now() + INDEX_BUDGET;
    let mut matches = Vec::new();
    let mut partial = false;
    for entry in entries {
        if Instant::now() >= deadline {
            partial = true;
            break;
        }
        tokio::task::yield_now().await;
        if let Some(quality) = match_quality(&entry, &words, deadline) {
            matches.push((entry, quality));
        }
    }
    partial |= Instant::now() >= deadline;
    matches.sort_by(|(a, qa), (b, qb)| {
        // History uses last-use first, then count. Tuple storage is count/date.
        let recent = || {
            let entry = |path: &str| history.get(path).map(|(count, date)| (date, count));
            entry(&b.path).cmp(&entry(&a.path))
        };
        if words.is_empty() {
            recent().then_with(|| a.path.cmp(&b.path))
        } else {
            qa.cmp(qb)
                .then_with(recent)
                .then_with(|| a.path.cmp(&b.path))
        }
    });
    let truncated = partial || matches.len() > MAX_RESULTS;
    (
        matches
            .into_iter()
            .take(MAX_RESULTS)
            .map(|(entry, _)| entry)
            .collect(),
        truncated,
    )
}

impl Core {
    pub async fn search_project_images(
        &self,
        request: &SearchProjectImages,
    ) -> Result<ProjectImageSearchResult> {
        if request.query.len() > 4096 {
            return Err(CoreError::Invalid("Search is too long.".into()));
        }
        let _reader = self.workspace.library_reader().await;
        let catalog = self.project_scope_catalog(&request.scope).await?;
        if catalog.version != request.membership_version {
            return Err(CoreError::SettingsConflict);
        }
        let ids = crate::project_scopes::selected_members(&catalog)?;
        let id = ids.first().ok_or(CoreError::SettingsScopeUnavailable)?;
        let project = self.store.project(id)?;
        let mut scope = ImageScope::new(&project, &self.workspace.root()?)?;
        let (entries, truncated) = enumerate(&mut scope).await?;
        let history = self.store.project_image_history(id)?;
        let (entries, ranked_truncated) = ranked(entries, &request.query, &history).await;
        let current = self.store.project(id)?;
        if current.path != project.path || !scope.contains_directory(scope.root()) {
            return Err(CoreError::StaleOwner);
        }
        let refreshed = self.project_scope_catalog(&request.scope).await?;
        if refreshed.version != request.membership_version {
            return Err(CoreError::SettingsConflict);
        }
        Ok(ProjectImageSearchResult {
            project_id: project.id,
            project_path: project.path,
            membership_version: catalog.version,
            entries,
            truncated: truncated || ranked_truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(path: &str) -> ProjectImageCandidate {
        ProjectImageCandidate {
            path: path.into(),
            name: path.rsplit('/').next().unwrap().into(),
        }
    }
    #[tokio::test]
    async fn subsequences_match_unicode_and_basename_quality_precedes_path_match() {
        let entries = [
            "logo/drawing.png",
            "other/logotype.svg",
            "assets/longgreatorange.png",
            "图标/蓝色花朵.png",
        ]
        .into_iter()
        .map(candidate)
        .collect();
        let (matches, _) = ranked(entries, "lgo", &BTreeMap::new()).await;
        assert_eq!(
            matches.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
            [
                "other/logotype.svg",
                "assets/longgreatorange.png",
                "logo/drawing.png"
            ]
        );
        assert_eq!(
            ranked(
                vec![candidate("图标/蓝色花朵.png")],
                "蓝花",
                &BTreeMap::new()
            )
            .await
            .0
            .len(),
            1
        );
    }
    #[tokio::test]
    async fn the_best_matches_are_selected_after_the_entire_pool_is_scored() {
        let mut entries: Vec<_> = (0..205)
            .map(|n| candidate(&format!("a{n}/f-a-v.png")))
            .collect();
        entries.push(candidate("z/favicon.svg"));
        let (ranked, truncated) = ranked(entries, "fav", &BTreeMap::new()).await;
        assert_eq!(ranked.len(), 200);
        assert!(truncated);
        assert_eq!(ranked[0].path, "z/favicon.svg");
    }
    #[tokio::test]
    async fn empty_query_prefers_recent_selections_then_count_and_stable_paths() {
        let history = BTreeMap::from([
            ("z.png".into(), (1, 20)),
            ("b.png".into(), (4, 10)),
            ("c.png".into(), (1, 10)),
        ]);
        let (ranked, _) = ranked(
            ["a.png", "c.png", "b.png", "z.png"]
                .into_iter()
                .map(candidate)
                .collect(),
            "",
            &history,
        )
        .await;
        assert_eq!(
            ranked.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
            ["z.png", "b.png", "c.png", "a.png"]
        );
    }
}
