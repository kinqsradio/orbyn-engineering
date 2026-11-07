//! Short-lived memory of what GitHub said about listed pull requests, so a refresh does
//! not ask again. Nothing here is stored or sent anywhere, and every entry expires.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use orbyn_contracts::PullDetails;

/// A known detail is trusted this long even when the pull request looks unchanged.
pub const DETAILS_TTL: Duration = Duration::from_secs(600);
/// After GitHub's GraphQL limit is hit, details are not asked for again for this long.
pub const DETAILS_PAUSE: Duration = Duration::from_secs(120);
const MAX_PER_PROJECT: usize = 1000;

struct Known {
    updated_at: Option<String>,
    details: PullDetails,
    at: Instant,
}

/// Details by project and pull request number. They are reused while the pull request's
/// `updated_at` is the same, which moves whenever a comment, review or request is added.
#[derive(Default)]
pub struct DetailCache {
    projects: HashMap<String, HashMap<u64, Known>>,
    paused_until: Option<Instant>,
}

impl DetailCache {
    pub fn paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|until| now < until)
    }

    pub fn pause(&mut self, now: Instant) {
        self.paused_until = Some(now + DETAILS_PAUSE);
    }

    pub fn lookup(
        &self,
        project: &str,
        number: u64,
        updated_at: Option<&str>,
        now: Instant,
    ) -> Option<PullDetails> {
        let known = self.projects.get(project)?.get(&number)?;
        (known.updated_at.as_deref() == updated_at
            && now.saturating_duration_since(known.at) < DETAILS_TTL)
            .then(|| known.details.clone())
    }

    pub fn store(&mut self, details: PullDetails, updated_at: Option<&str>, now: Instant) {
        let known = self.projects.entry(details.project_id.clone()).or_default();
        if known.len() >= MAX_PER_PROJECT {
            known.clear();
        }
        known.insert(
            details.number,
            Known {
                updated_at: updated_at.map(str::to_owned),
                details,
                at: now,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(number: u64) -> PullDetails {
        PullDetails {
            project_id: "p".into(),
            number,
            created_at: None,
            requested_reviewers: None,
            comment_count: Some(9),
            viewer_review_state: None,
        }
    }

    #[test]
    fn details_hold_until_the_pull_request_changes_or_ages() {
        let mut cache = DetailCache::default();
        let start = Instant::now();
        cache.store(details(7), Some("t1"), start);
        assert_eq!(cache.lookup("p", 7, Some("t1"), start), Some(details(7)));
        assert_eq!(cache.lookup("p", 7, Some("t2"), start), None);
        assert_eq!(cache.lookup("q", 7, Some("t1"), start), None);
        let before = start + DETAILS_TTL - Duration::from_secs(1);
        assert!(cache.lookup("p", 7, Some("t1"), before).is_some());
        assert_eq!(cache.lookup("p", 7, Some("t1"), start + DETAILS_TTL), None);
    }

    #[test]
    fn counting_stays_paused_for_two_minutes_then_resumes() {
        let mut cache = DetailCache::default();
        let start = Instant::now();
        assert!(!cache.paused(start));
        cache.pause(start);
        assert_eq!(DETAILS_PAUSE, Duration::from_secs(120));
        assert!(cache.paused(start));
        assert!(cache.paused(start + DETAILS_PAUSE - Duration::from_secs(1)));
        assert!(!cache.paused(start + DETAILS_PAUSE));
    }
}
