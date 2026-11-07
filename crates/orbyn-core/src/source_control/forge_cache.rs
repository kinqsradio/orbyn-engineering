//! Short-lived memory of what a forge CLI said, so a list does not ask again.
//! Nothing here is stored or sent anywhere, and every entry expires on its own.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// A found login is trusted this long: long enough that lists do not ask, short enough
/// that a `gh auth switch` outside Orbyn is noticed.
pub const VIEWER_TTL: Duration = Duration::from_secs(300);
/// A failed lookup is remembered this long, so a signed-out CLI is not asked on every list.
pub const VIEWER_FAILURE_TTL: Duration = Duration::from_secs(30);
/// A comment total is trusted this long even when the pull request looks unchanged.
pub const COUNT_TTL: Duration = Duration::from_secs(600);
/// After GitHub's GraphQL limit is hit, counts are not asked for again for this long.
pub const COUNT_PAUSE: Duration = Duration::from_secs(120);
const MAX_COUNTS_PER_PROJECT: usize = 1000;

/// The signed-in login per forge and host, so github.com and an enterprise host never share one.
#[derive(Default)]
pub struct ViewerCache {
    entries: HashMap<String, (Option<String>, Instant)>,
}

impl ViewerCache {
    pub fn key(forge: &str, host: &str) -> String {
        format!("{forge}@{host}")
    }

    /// `Some(None)` is a remembered failure; `None` means ask the CLI.
    pub fn get(&self, key: &str, now: Instant) -> Option<Option<String>> {
        let (login, at) = self.entries.get(key)?;
        let ttl = if login.is_some() {
            VIEWER_TTL
        } else {
            VIEWER_FAILURE_TTL
        };
        (now.saturating_duration_since(*at) < ttl).then(|| login.clone())
    }

    pub fn put(&mut self, key: &str, login: Option<String>, now: Instant) {
        self.entries.insert(key.to_owned(), (login, now));
    }

    /// Forgets one entry, such as after a call failed because the login is gone.
    pub fn evict(&mut self, key: &str) {
        self.entries.remove(key);
    }

    /// Forgets every host of one forge, as a rescan does.
    pub fn evict_forge(&mut self, forge: &str) {
        let prefix = format!("{forge}@");
        self.entries.retain(|key, _| !key.starts_with(&prefix));
    }
}

struct Counted {
    updated_at: Option<String>,
    count: u32,
    at: Instant,
}

/// Comment totals by project and pull request number. A total is reused while the pull
/// request's `updated_at` is the same, which moves whenever a comment is added.
#[derive(Default)]
pub struct CountCache {
    projects: HashMap<String, HashMap<u64, Counted>>,
    paused_until: Option<Instant>,
}

impl CountCache {
    pub fn paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|until| now < until)
    }

    pub fn pause(&mut self, now: Instant) {
        self.paused_until = Some(now + COUNT_PAUSE);
    }

    pub fn lookup(
        &self,
        project: &str,
        number: u64,
        updated_at: Option<&str>,
        now: Instant,
    ) -> Option<u32> {
        let known = self.projects.get(project)?.get(&number)?;
        (known.updated_at.as_deref() == updated_at
            && now.saturating_duration_since(known.at) < COUNT_TTL)
            .then_some(known.count)
    }

    pub fn store(
        &mut self,
        project: &str,
        number: u64,
        updated_at: Option<&str>,
        count: u32,
        now: Instant,
    ) {
        let counts = self.projects.entry(project.to_owned()).or_default();
        if counts.len() >= MAX_COUNTS_PER_PROJECT {
            counts.clear();
        }
        counts.insert(
            number,
            Counted {
                updated_at: updated_at.map(str::to_owned),
                count,
                at: now,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_login_is_kept_per_host() {
        let mut cache = ViewerCache::default();
        let now = Instant::now();
        let hub = ViewerCache::key("github", "github.com");
        let ghe = ViewerCache::key("github", "ghe.corp.example");
        assert_ne!(hub, ghe);
        cache.put(&hub, Some("octo".into()), now);
        assert_eq!(cache.get(&hub, now), Some(Some("octo".into())));
        assert_eq!(cache.get(&ghe, now), None);
    }

    #[test]
    fn a_login_expires_and_can_be_evicted() {
        let mut cache = ViewerCache::default();
        let start = Instant::now();
        let key = ViewerCache::key("github", "github.com");
        cache.put(&key, Some("octo".into()), start);
        let before = start + VIEWER_TTL - Duration::from_secs(1);
        assert_eq!(cache.get(&key, before), Some(Some("octo".into())));
        assert_eq!(cache.get(&key, start + VIEWER_TTL), None);
        cache.put(&key, Some("octo".into()), start);
        cache.evict(&key);
        assert_eq!(cache.get(&key, start), None);
    }

    #[test]
    fn a_failed_lookup_is_remembered_briefly() {
        let mut cache = ViewerCache::default();
        let start = Instant::now();
        let key = ViewerCache::key("github", "github.com");
        cache.put(&key, None, start);
        assert_eq!(cache.get(&key, start + Duration::from_secs(1)), Some(None));
        assert_eq!(cache.get(&key, start + VIEWER_FAILURE_TTL), None);
        assert!(VIEWER_FAILURE_TTL < VIEWER_TTL);
    }

    #[test]
    fn a_rescan_forgets_every_host_of_one_forge_only() {
        let mut cache = ViewerCache::default();
        let now = Instant::now();
        for (forge, host) in [
            ("github", "github.com"),
            ("github", "ghe.x"),
            ("gitlab", "gitlab.com"),
        ] {
            cache.put(&ViewerCache::key(forge, host), Some("u".into()), now);
        }
        cache.evict_forge("github");
        assert_eq!(cache.get(&ViewerCache::key("github", "ghe.x"), now), None);
        assert!(
            cache
                .get(&ViewerCache::key("gitlab", "gitlab.com"), now)
                .is_some()
        );
    }

    #[test]
    fn a_count_holds_until_the_pull_request_changes_or_ages() {
        let mut cache = CountCache::default();
        let start = Instant::now();
        cache.store("p", 7, Some("t1"), 9, start);
        assert_eq!(cache.lookup("p", 7, Some("t1"), start), Some(9));
        assert_eq!(cache.lookup("p", 7, Some("t2"), start), None);
        assert_eq!(cache.lookup("q", 7, Some("t1"), start), None);
        assert_eq!(cache.lookup("p", 7, Some("t1"), start + COUNT_TTL), None);
    }

    #[test]
    fn counting_pauses_then_resumes() {
        let mut cache = CountCache::default();
        let start = Instant::now();
        assert!(!cache.paused(start));
        cache.pause(start);
        assert!(cache.paused(start + COUNT_PAUSE - Duration::from_secs(1)));
        assert!(!cache.paused(start + COUNT_PAUSE));
    }
}
