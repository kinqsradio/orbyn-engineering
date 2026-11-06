//! A durable copy of each engine's last good model list, so a restart with an
//! engine unavailable still offers what it last reported. A cache that cannot
//! be read or written is simply ignored.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use orbyn_contracts::EngineModels;
use serde::{Deserialize, Serialize};

const FILE: &str = "catalog.json";
const VERSION: u32 = 1;
/// Enough for every known engine and its instances, without growing forever.
const MAX_ENGINES: usize = 32;

/// One engine's list, with the catalog key it was read under.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub key: Option<String>,
    pub models: EngineModels,
}

#[derive(Serialize, Deserialize)]
struct Catalog {
    version: u32,
    engines: BTreeMap<String, Entry>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: VERSION,
            engines: BTreeMap::new(),
        }
    }
}

/// The last good lists on disk. `None` keeps them in memory only.
#[derive(Clone, Debug)]
pub struct CatalogCache {
    dir: Option<PathBuf>,
}

impl CatalogCache {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir }
    }

    pub fn load(&self, engine: &str) -> Option<Entry> {
        self.read()?.engines.remove(engine)
    }

    /// Failures are swallowed: a model read must not fail for want of a cache.
    pub fn save(&self, engine: &str, entry: &Entry) {
        let _ = self.write(engine, entry);
    }

    fn path(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    fn read(&self) -> Option<Catalog> {
        let text = fs::read_to_string(self.path()?.join(FILE)).ok()?;
        let catalog: Catalog = serde_json::from_str(&text).ok()?;
        (catalog.version == VERSION).then_some(catalog)
    }

    fn write(&self, engine: &str, entry: &Entry) -> io::Result<()> {
        let dir = self
            .path()
            .ok_or_else(|| io::Error::other("no catalog cache directory"))?;
        fs::create_dir_all(dir)?;
        let mut catalog = self.read().unwrap_or_default();
        catalog.engines.insert(engine.to_owned(), entry.clone());
        while catalog.engines.len() > MAX_ENGINES {
            let oldest = catalog
                .engines
                .iter()
                .min_by_key(|(_, entry)| entry.models.checked_at.as_str())
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => catalog.engines.remove(&id),
                None => break,
            };
        }
        let text = serde_json::to_string_pretty(&catalog).map_err(io::Error::other)?;
        let temp = dir.join(format!(
            ".{FILE}.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&temp, text)?;
        if let Err(error) = fs::rename(&temp, dir.join(FILE)) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        Ok(())
    }
}

static NEXT: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use orbyn_contracts::ModelInfo;

    fn models(checked_at: &str) -> EngineModels {
        EngineModels {
            engine: "codex".into(),
            source: "engine".into(),
            models: vec![ModelInfo {
                id: "gpt-5".into(),
                label: "GPT-5".into(),
                description: None,
                is_default: true,
                custom: false,
                options: Vec::new(),
                input_modalities: Vec::new(),
                upgrade: None,
            }],
            error: None,
            checked_at: checked_at.into(),
            fallback: false,
            options: Vec::new(),
            agents: Vec::new(),
            output_styles: Vec::new(),
            output_style: None,
            remembered: None,
        }
    }

    fn cache(dir: &TempDir) -> CatalogCache {
        CatalogCache::new(Some(dir.path().join("model-cache")))
    }

    #[test]
    fn a_saved_entry_round_trips() {
        let dir = TempDir::new();
        let cache = cache(&dir);
        let entry = Entry {
            key: Some("0.166.0|logged_out".into()),
            models: models("2026-11-05T10:00:00Z"),
        };
        cache.save("codex", &entry);
        let loaded = cache.load("codex").unwrap();
        assert_eq!(loaded.key, entry.key);
        assert_eq!(loaded.models, entry.models);
        assert!(dir.path().join("model-cache/catalog.json").exists());
    }

    #[test]
    fn a_missing_entry_is_not_invented() {
        let dir = TempDir::new();
        assert!(cache(&dir).load("codex").is_none());
        assert!(CatalogCache::new(None).load("codex").is_none());
    }

    #[test]
    fn corrupt_json_is_ignored_and_replaced() {
        let dir = TempDir::new();
        let cache = cache(&dir);
        let path = dir.path().join("model-cache/catalog.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert!(cache.load("codex").is_none());
        cache.save(
            "codex",
            &Entry {
                key: None,
                models: models("2026-11-05T10:00:00Z"),
            },
        );
        assert!(cache.load("codex").is_some());
    }

    #[test]
    fn an_unusable_directory_is_ignored() {
        let dir = TempDir::new();
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, "a file, not a directory").unwrap();
        let cache = CatalogCache::new(Some(blocked.join("model-cache")));
        cache.save(
            "codex",
            &Entry {
                key: None,
                models: models("2026-11-05T10:00:00Z"),
            },
        );
        assert!(cache.load("codex").is_none());
    }

    #[test]
    fn the_oldest_entry_is_evicted_past_the_cap() {
        let dir = TempDir::new();
        let cache = cache(&dir);
        for index in 0..MAX_ENGINES {
            let stamp = format!("2026-11-05T10:00:{index:02}Z");
            cache.save(
                &format!("engine-{index}"),
                &Entry {
                    key: None,
                    models: models(&stamp),
                },
            );
        }
        cache.save(
            "engine-new",
            &Entry {
                key: None,
                models: models("2026-11-05T11:00:00Z"),
            },
        );
        assert!(cache.load("engine-0").is_none());
        assert!(cache.load("engine-1").is_some());
        assert!(cache.load("engine-new").is_some());
    }
}
