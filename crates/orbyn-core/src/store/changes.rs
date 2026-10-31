//! What runs changed, as bytes. A file's first look is what the run found and its
//! last is what it left, and both budgets are spent here so two tools in one run
//! cannot pass them together.

use orbyn_contracts::{ChangeStatus, ChangedFile};
use rusqlite::{OptionalExtension, params};

use super::{Store, now};
use crate::error::Result;

/// A file's state at one moment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Snapshot {
    Absent,
    Stored(Vec<u8>),
    /// Too large, a link, or otherwise not kept.
    Unknown,
}

impl Snapshot {
    fn word(&self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Stored(_) => "stored",
            Self::Unknown => "unknown",
        }
    }

    fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Stored(bytes) => Some(bytes),
            _ => None,
        }
    }

    fn read(state: &str, bytes: Option<Vec<u8>>) -> Self {
        match (state, bytes) {
            ("absent", _) => Self::Absent,
            ("stored", Some(bytes)) => Self::Stored(bytes),
            _ => Self::Unknown,
        }
    }

    fn size(&self) -> i64 {
        self.bytes()
            .map_or(0, |bytes| i64::try_from(bytes.len()).unwrap_or(i64::MAX))
    }
}

/// Both ends of a file's change in one run.
#[derive(Clone, Debug)]
pub struct KeptChange {
    pub path: String,
    pub before: Snapshot,
    pub after: Snapshot,
}

impl KeptChange {
    pub fn status(&self) -> ChangeStatus {
        use Snapshot::{Absent, Stored, Unknown};
        match (&self.before, &self.after) {
            (Unknown, _) | (_, Unknown) => ChangeStatus::Unknown,
            (Absent, Absent) => ChangeStatus::Unchanged,
            (Absent, Stored(_)) => ChangeStatus::Added,
            (Stored(_), Absent) => ChangeStatus::Deleted,
            (Stored(old), Stored(new)) if old == new => ChangeStatus::Unchanged,
            (Stored(_), Stored(_)) => ChangeStatus::Modified,
        }
    }
}

const SELECT: &str = "SELECT path, before_state, before_bytes, after_state, after_bytes
                      FROM run_file_changes WHERE run_id = ?1";

fn change_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KeptChange> {
    let before: String = row.get(1)?;
    let after: String = row.get(3)?;
    Ok(KeptChange {
        path: row.get(0)?,
        before: Snapshot::read(&before, row.get(2)?),
        after: Snapshot::read(&after, row.get(4)?),
    })
}

impl Store {
    /// Keeps a look at a file. The first for a path sets what the run found; a look
    /// with `done` sets what it left. Past `max_files` a new path is dropped, and past
    /// `max_bytes` for the run a look is kept as unknown.
    pub fn record_change(
        &self,
        run_id: &str,
        path: &str,
        snapshot: Snapshot,
        done: bool,
        (max_files, max_bytes): (i64, i64),
    ) -> Result<()> {
        self.commit(|tx, _| {
            let known = tx
                .query_row(
                    "SELECT 1 FROM run_file_changes WHERE run_id = ?1 AND path = ?2",
                    params![run_id, path],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let (files, used): (i64, i64) = tx.query_row(
                "SELECT COUNT(*), COALESCE(SUM(COALESCE(LENGTH(before_bytes), 0)
                                            + COALESCE(LENGTH(after_bytes), 0)), 0)
                 FROM run_file_changes WHERE run_id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if !known && files >= max_files {
                return Ok(());
            }
            let snapshot = if used.saturating_add(snapshot.size()) > max_bytes {
                Snapshot::Unknown
            } else {
                snapshot
            };
            if !known {
                let (before, after) = if done {
                    (Snapshot::Unknown, &snapshot)
                } else {
                    (snapshot.clone(), &snapshot)
                };
                tx.execute(
                    "INSERT INTO run_file_changes
                        (run_id, path, before_state, before_bytes, after_state, after_bytes,
                         recorded_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        run_id,
                        path,
                        before.word(),
                        before.bytes(),
                        after.word(),
                        after.bytes(),
                        now(),
                    ],
                )?;
            } else if done {
                tx.execute(
                    "UPDATE run_file_changes SET after_state = ?3, after_bytes = ?4
                     WHERE run_id = ?1 AND path = ?2",
                    params![run_id, path, snapshot.word(), snapshot.bytes()],
                )?;
            }
            Ok(())
        })
    }

    /// Sets what a run found, if nothing did yet and the run's budget allows it.
    pub fn fill_change_start(
        &self,
        run_id: &str,
        path: &str,
        snapshot: &Snapshot,
        max_bytes: i64,
    ) -> Result<()> {
        self.commit(|tx, _| {
            let used: i64 = tx.query_row(
                "SELECT COALESCE(SUM(COALESCE(LENGTH(before_bytes), 0)
                                   + COALESCE(LENGTH(after_bytes), 0)), 0)
                 FROM run_file_changes WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )?;
            if used.saturating_add(snapshot.size()) > max_bytes {
                return Ok(());
            }
            tx.execute(
                "UPDATE run_file_changes SET before_state = ?3, before_bytes = ?4
                 WHERE run_id = ?1 AND path = ?2 AND before_state = 'unknown'",
                params![run_id, path, snapshot.word(), snapshot.bytes()],
            )?;
            Ok(())
        })
    }

    pub fn kept_changes(&self, run_id: &str) -> Result<Vec<KeptChange>> {
        let conn = self.reader();
        let mut statement = conn.prepare(&format!("{SELECT} ORDER BY path"))?;
        let rows = statement.query_map([run_id], change_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn kept_change(&self, run_id: &str, path: &str) -> Result<Option<KeptChange>> {
        Ok(self
            .reader()
            .query_row(
                &format!("{SELECT} AND path = ?2"),
                [run_id, path],
                change_row,
            )
            .optional()?)
    }

    pub fn changed_files(&self, run_id: &str) -> Result<Vec<ChangedFile>> {
        Ok(self
            .kept_changes(run_id)?
            .iter()
            .map(|change| ChangedFile {
                path: change.path.clone(),
                status: change.status(),
                restorable: change.status() != ChangeStatus::Unknown,
            })
            .collect())
    }

    /// Drops the oldest kept bytes past `budget` across all runs. The list of paths
    /// stays, as unknown, so a run still says what it touched.
    pub fn prune_changes(&self, budget: i64) -> Result<()> {
        self.commit(|tx, _| {
            let mut used: i64 = tx.query_row(
                "SELECT COALESCE(SUM(COALESCE(LENGTH(before_bytes), 0)
                                   + COALESCE(LENGTH(after_bytes), 0)), 0)
                 FROM run_file_changes",
                [],
                |row| row.get(0),
            )?;
            if used <= budget {
                return Ok(());
            }
            let mut statement = tx.prepare(
                "SELECT run_id, path, COALESCE(LENGTH(before_bytes), 0)
                                    + COALESCE(LENGTH(after_bytes), 0)
                 FROM run_file_changes
                 WHERE before_bytes IS NOT NULL OR after_bytes IS NOT NULL
                 ORDER BY recorded_at, run_id, path",
            )?;
            let oldest = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for (run, path, size) in oldest {
                if used <= budget {
                    break;
                }
                tx.execute(
                    "UPDATE run_file_changes
                     SET before_state = 'unknown', before_bytes = NULL,
                         after_state = 'unknown', after_bytes = NULL
                     WHERE run_id = ?1 AND path = ?2",
                    params![run, path],
                )?;
                used -= size;
            }
            Ok(())
        })
    }
}
