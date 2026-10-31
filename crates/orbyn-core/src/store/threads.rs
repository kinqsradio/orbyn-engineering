//! Thread lifecycle writes: pin, archive, settle, snooze, unread, order.
//! Each change and its log notice commit together, so a client following the
//! thread sees it without polling.

use orbyn_contracts::{
    AgUiEvent, AutoSettleChoice, AutoSettleSettings, ServerSettings, SnoozePreset, Thread,
    UpdateThread,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::{ACTIVE_STATES, Appended, AuditRecord, Store, insert_audit, insert_event};
use crate::error::{CoreError, Result};
use crate::util::{now, parse_time, unix_now};

const SETTINGS_KEY: &str = "server_settings";
pub const MAX_SNOOZE_PRESETS: usize = 8;
const MAX_SNOOZE_MINUTES: u32 = 30 * 24 * 60;
const MAX_TITLE_CHARS: usize = 200;
const MAX_INSTRUCTION_CHARS: usize = 2_000;
const MAX_AUTO_SETTLE_DAYS: u32 = 365;

/// Automatic settling, resolved for one tick.
#[derive(Clone, Copy, Debug)]
pub struct LifecycleRules {
    pub now: i64,
    pub idle_seconds: Option<i64>,
    pub keep_pull_requests: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TickReport {
    pub woken: Vec<String>,
    pub settled: Vec<String>,
}

/// A thread and everything below it, deepest last.
pub(crate) fn thread_family(tx: &Transaction<'_>, id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare(
        "WITH RECURSIVE family(id) AS (
            SELECT id FROM threads WHERE id = ?1
            UNION SELECT threads.id FROM threads
                JOIN family ON threads.parent_thread_id = family.id
         ) SELECT id FROM family",
    )?;
    let family = statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    if family.is_empty() {
        return Err(CoreError::NotFound("thread".into()));
    }
    Ok(family)
}

fn has_active_run(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    Ok(tx.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM runs WHERE thread_id = ?1 AND state IN {ACTIVE_STATES})"
        ),
        [id],
        |row| row.get(0),
    )?)
}

fn notify(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    thread_id: &str,
    change: &str,
) -> Result<()> {
    insert_event(
        tx,
        appended,
        thread_id,
        None,
        &AgUiEvent::Custom {
            name: "thread.updated".into(),
            value: json!({ "change": change }),
        },
    )?;
    Ok(())
}

fn audit(tx: &Transaction<'_>, actor: &str, action: &str, id: &str, detail: Value) -> Result<()> {
    insert_audit(
        tx,
        &AuditRecord {
            actor: actor.to_owned(),
            action: action.to_owned(),
            target: id.to_owned(),
            decision: None,
            source: if actor.starts_with("system") {
                "system".to_owned()
            } else {
                "user".to_owned()
            },
            thread_id: Some(id.to_owned()),
            run_id: None,
            detail,
        },
    )?;
    Ok(())
}

impl Store {
    /// Applies one patch in one transaction: it lands whole or not at all.
    pub fn update_thread(&self, id: &str, patch: &UpdateThread, actor: &str) -> Result<Thread> {
        let snooze = patch
            .snoozed_until
            .as_deref()
            .map(|until| {
                let at = parse_time(until)
                    .ok_or_else(|| CoreError::Invalid("Enter a valid snooze time.".into()))?;
                if at <= unix_now() {
                    return Err(CoreError::Invalid("Snooze until a future time.".into()));
                }
                Ok(until.to_owned())
            })
            .transpose()?;
        let title = patch
            .title
            .as_deref()
            .map(|title| {
                let title = title.trim();
                if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
                    return Err(CoreError::Invalid(
                        "Use a title of 1 to 200 characters.".into(),
                    ));
                }
                Ok(title.to_owned())
            })
            .transpose()?;
        self.commit(|tx, appended| {
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM threads WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(CoreError::NotFound("thread".into()));
            }
            let busy = has_active_run(tx, id)?;
            let stamp = now();
            if let Some(title) = &title {
                tx.execute(
                    "UPDATE threads SET title = ?2 WHERE id = ?1",
                    params![id, title],
                )?;
                audit(tx, actor, "thread.rename", id, json!({ "title": title }))?;
                notify(tx, appended, id, "title")?;
            }
            if let Some(pinned) = patch.pinned {
                let value = pinned.then(|| stamp.clone());
                tx.execute(
                    "UPDATE threads SET pinned_at = ?2 WHERE id = ?1",
                    params![id, value],
                )?;
                notify(tx, appended, id, "pin")?;
            }
            if let Some(unread) = patch.unread {
                tx.execute(
                    "UPDATE threads SET unread = ?2 WHERE id = ?1",
                    params![id, unread],
                )?;
                notify(tx, appended, id, "unread")?;
            }
            if let Some(choice) = patch.auto_settle {
                let value = match choice {
                    AutoSettleChoice::Inherit => None,
                    AutoSettleChoice::Enabled => Some(true),
                    AutoSettleChoice::Disabled => Some(false),
                };
                tx.execute(
                    "UPDATE threads SET auto_settle = ?2 WHERE id = ?1",
                    params![id, value],
                )?;
                notify(tx, appended, id, "auto_settle")?;
            }
            if let Some(mode) = patch.permission_mode {
                tx.execute(
                    "UPDATE threads SET permission_mode = ?2 WHERE id = ?1",
                    params![id, super::wire_name(mode)?],
                )?;
                audit(
                    tx,
                    actor,
                    "thread.permission_mode",
                    id,
                    json!({ "mode": mode }),
                )?;
                notify(tx, appended, id, "permission_mode")?;
            }
            if let Some(model) = &patch.model {
                let value = Some(model.trim()).filter(|model| !model.is_empty());
                tx.execute(
                    "UPDATE threads SET model = ?2 WHERE id = ?1",
                    params![id, value],
                )?;
                notify(tx, appended, id, "model")?;
            }
            if let Some(effort) = &patch.effort {
                let value = Some(effort.trim()).filter(|effort| !effort.is_empty());
                tx.execute(
                    "UPDATE threads SET effort = ?2 WHERE id = ?1",
                    params![id, value],
                )?;
                notify(tx, appended, id, "effort")?;
            }
            if let Some(plan) = patch.plan_mode {
                tx.execute(
                    "UPDATE threads SET plan_mode = ?2 WHERE id = ?1",
                    params![id, plan],
                )?;
                notify(tx, appended, id, "plan_mode")?;
            }
            if let Some(settled) = patch.settled {
                if settled {
                    if busy {
                        return Err(CoreError::ThreadBusy);
                    }
                    settle(tx, appended, id, actor)?;
                } else {
                    // Back on top, and safe from automatic settling until new activity.
                    tx.execute(
                        "UPDATE threads SET settled_at = NULL, settle_hold = 1, position =
                            (SELECT COALESCE(MIN(position), 0) - 1 FROM threads)
                         WHERE id = ?1",
                        [id],
                    )?;
                    notify(tx, appended, id, "unsettle")?;
                }
            }
            if let Some(archived) = patch.archived {
                if archived && busy {
                    return Err(CoreError::ThreadBusy);
                }
                let value = archived.then(|| stamp.clone());
                tx.execute(
                    "UPDATE threads SET archived_at = ?2, pinned_at =
                        CASE WHEN ?2 IS NULL THEN pinned_at END WHERE id = ?1",
                    params![id, value],
                )?;
                audit(
                    tx,
                    actor,
                    "thread.archive",
                    id,
                    json!({ "archived": archived }),
                )?;
                notify(tx, appended, id, "archive")?;
            }
            if patch.wake == Some(true) {
                tx.execute(
                    "UPDATE threads SET snoozed_until = NULL WHERE id = ?1",
                    [id],
                )?;
                notify(tx, appended, id, "wake")?;
            }
            if let Some(until) = &snooze {
                let archived: bool = tx.query_row(
                    "SELECT archived_at IS NOT NULL FROM threads WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                if archived {
                    return Err(CoreError::ThreadArchived);
                }
                tx.execute(
                    "UPDATE threads SET snoozed_until = ?2, settled_at = NULL WHERE id = ?1",
                    params![id, until],
                )?;
                notify(tx, appended, id, "snooze")?;
            }
            Ok(())
        })?;
        self.thread(id)
    }

    /// Logs a thread-level notice outside any run.
    pub fn note_thread_event(&self, id: &str, name: &str, value: Value) -> Result<()> {
        self.commit(|tx, appended| {
            insert_event(
                tx,
                appended,
                id,
                None,
                &AgUiEvent::Custom {
                    name: name.to_owned(),
                    value,
                },
            )?;
            Ok(())
        })
    }

    /// Writes a generated title unless someone renamed the thread meanwhile.
    pub fn apply_generated_title(&self, id: &str, expected: &str, title: &str) -> Result<bool> {
        self.commit(|tx, appended| {
            let changed = tx.execute(
                "UPDATE threads SET title = ?3 WHERE id = ?1 AND title = ?2",
                params![id, expected, title],
            )?;
            if changed > 0 {
                notify(tx, appended, id, "title")?;
            }
            Ok(changed > 0)
        })
    }

    /// Saves a new order. Every id is checked first, so a stale list changes nothing.
    pub fn reorder_threads(&self, ids: &[String]) -> Result<()> {
        self.commit(|tx, appended| {
            let positions = (0..ids.len()).map(|index| index as f64);
            let lowest: f64 = tx.query_row(
                "SELECT COALESCE(MIN(position), 0) FROM threads",
                [],
                |row| row.get(0),
            )?;
            let start = lowest - ids.len() as f64;
            for (id, offset) in ids.iter().zip(positions) {
                let changed = tx.execute(
                    "UPDATE threads SET position = ?2 WHERE id = ?1",
                    params![id, start + offset],
                )?;
                if changed == 0 {
                    return Err(CoreError::NotFound("thread".into()));
                }
                notify(tx, appended, id, "order")?;
            }
            Ok(())
        })
    }

    /// Text of the conversation for a title, newest content dropped first.
    pub fn transcript(&self, thread_id: &str, max_chars: usize) -> Result<String> {
        let mut text = String::new();
        let mut cursor = 0;
        loop {
            let batch = self.events_after(thread_id, cursor, 500)?;
            let Some(last) = batch.last() else {
                return Ok(text);
            };
            cursor = last.seq;
            for event in batch {
                if let AgUiEvent::TextMessageContent { delta, .. } = event.event {
                    text.push_str(&delta);
                    text.push('\n');
                    if text.chars().count() >= max_chars {
                        return Ok(text.chars().take(max_chars).collect());
                    }
                }
            }
        }
    }

    /// Ends snoozes that are due and settles threads the rules cover.
    pub fn lifecycle_tick(&self, rules: LifecycleRules) -> Result<TickReport> {
        self.commit(|tx, appended| {
            let mut report = TickReport::default();
            let mut statement = tx
                .prepare("SELECT id, snoozed_until FROM threads WHERE snoozed_until IS NOT NULL")?;
            let snoozed = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            for (id, until) in snoozed {
                if parse_time(&until).is_none_or(|at| at <= rules.now) {
                    tx.execute(
                        "UPDATE threads SET snoozed_until = NULL, unread = 1 WHERE id = ?1",
                        [&id],
                    )?;
                    notify(tx, appended, &id, "wake")?;
                    report.woken.push(id);
                }
            }
            let mut statement = tx.prepare(
                "SELECT id, updated_at, auto_settle FROM threads
                 WHERE settled_at IS NULL AND archived_at IS NULL AND snoozed_until IS NULL
                    AND settle_hold = 0 AND COALESCE(auto_settle, 1) = 1",
            )?;
            let candidates = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<bool>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            for (id, updated, own) in candidates {
                // A thread's own Enabled still needs a window when the global rule is off.
                let window = rules.idle_seconds.or(own.map(|_| DEFAULT_IDLE_SECONDS));
                let Some(window) = window else { continue };
                if parse_time(&updated).is_none_or(|at| rules.now - at < window) {
                    continue;
                }
                if family_is_busy(tx, &id)?
                    || (rules.keep_pull_requests && has_open_pull_request(tx, &id)?)
                {
                    continue;
                }
                settle(tx, appended, &id, "system:auto-settle")?;
                report.settled.push(id);
            }
            Ok(report)
        })
    }

    pub fn settings(&self) -> Result<ServerSettings> {
        let stored = self.setting(SETTINGS_KEY)?;
        Ok(stored
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_else(default_settings))
    }

    pub fn save_settings(&self, settings: &ServerSettings, actor: &str) -> Result<()> {
        if settings.snooze_presets.len() > MAX_SNOOZE_PRESETS {
            return Err(CoreError::Invalid("Keep to 8 snooze presets.".into()));
        }
        if settings
            .snooze_presets
            .iter()
            .any(|preset| preset.minutes == 0 || preset.minutes > MAX_SNOOZE_MINUTES)
        {
            return Err(CoreError::Invalid(
                "Snooze presets run from one minute to 30 days.".into(),
            ));
        }
        if settings
            .auto_settle
            .after_days
            .is_some_and(|days| days == 0 || days > MAX_AUTO_SETTLE_DAYS)
        {
            return Err(CoreError::Invalid(
                "Auto-settle runs from 1 to 365 days.".into(),
            ));
        }
        if settings
            .title_instructions
            .as_ref()
            .is_some_and(|text| text.chars().count() > MAX_INSTRUCTION_CHARS)
        {
            return Err(CoreError::Invalid("Keep title instructions short.".into()));
        }
        let text = serde_json::to_string(settings)?;
        self.commit(|tx, _| {
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "settings.save".into(),
                    target: SETTINGS_KEY.to_owned(),
                    decision: None,
                    source: "user".into(),
                    thread_id: None,
                    run_id: None,
                    detail: Value::Null,
                },
            )?;
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![SETTINGS_KEY, text],
            )?;
            Ok(())
        })
    }
}

const DEFAULT_IDLE_SECONDS: i64 = 3 * 24 * 60 * 60;

pub fn default_settings() -> ServerSettings {
    ServerSettings {
        auto_settle: AutoSettleSettings {
            after_days: Some(3),
            on_merge: true,
            keep_pull_requests: false,
        },
        snooze_presets: [
            ("1 hour", 60),
            ("Tomorrow", 24 * 60),
            ("Next week", 7 * 24 * 60),
        ]
        .into_iter()
        .map(|(label, minutes)| SnoozePreset {
            label: label.to_owned(),
            minutes,
        })
        .collect(),
        title_instructions: None,
        background_update_checks: None,
        model_prices: Vec::new(),
        model_aliases: Vec::new(),
    }
}

fn settle(tx: &Transaction<'_>, appended: &mut Appended, id: &str, actor: &str) -> Result<()> {
    // Settling removes the pin and ends any snooze.
    tx.execute(
        "UPDATE threads SET settled_at = ?2, pinned_at = NULL, snoozed_until = NULL
         WHERE id = ?1",
        params![id, now()],
    )?;
    audit(tx, actor, "thread.settle", id, Value::Null)?;
    notify(tx, appended, id, "settle")
}

/// A running descendant means this thread is still waiting on delegated work.
fn family_is_busy(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    for member in thread_family(tx, id)? {
        if has_active_run(tx, &member)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn has_open_pull_request(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    let table: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = 'thread_pull_requests'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if table.is_none() {
        return Ok(false);
    }
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM thread_pull_requests
            WHERE thread_id = ?1 AND state = 'open')",
        [id],
        |row| row.get(0),
    )?)
}
