//! Policy rules, skill profiles, custom engines and settings.

use orbyn_contracts::{
    ActionKind, CreatePolicyRule, CustomEngine, PolicyEffect, PolicyRule, SkillProfile,
};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::Value;

use super::{AuditRecord, Store, insert_audit, parse_json, parse_wire, wire_name};
use crate::error::{CoreError, Result};
use crate::util::{new_id, now};

fn rule_row(row: &Row<'_>) -> rusqlite::Result<PolicyRule> {
    Ok(PolicyRule {
        id: row.get("id")?,
        effect: parse_wire::<PolicyEffect>(1, row.get("effect")?)?,
        kind: parse_wire::<ActionKind>(2, row.get("kind")?)?,
        pattern: row.get("pattern")?,
        engine: row.get("engine")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

fn profile_row(row: &Row<'_>) -> rusqlite::Result<SkillProfile> {
    let skills: String = row.get("skills")?;
    Ok(SkillProfile {
        id: row.get("id")?,
        name: row.get("name")?,
        skills: parse_json(2, &skills)?,
    })
}

fn engine_row(row: &Row<'_>) -> rusqlite::Result<CustomEngine> {
    let args: String = row.get("args")?;
    Ok(CustomEngine {
        id: row.get("id")?,
        name: row.get("name")?,
        tier: parse_wire(2, row.get("tier")?)?,
        target: row.get("target")?,
        args: parse_json(4, &args)?,
    })
}

impl Store {
    pub fn list_rules(&self) -> Result<Vec<PolicyRule>> {
        let conn = self.reader();
        let mut statement =
            conn.prepare_cached("SELECT * FROM policy_rules ORDER BY created_at")?;
        let rows = statement.query_map([], rule_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn add_rule(&self, rule: &CreatePolicyRule, actor: &str) -> Result<PolicyRule> {
        let id = new_id();
        let stamp = now();
        self.commit(|tx, _| {
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "policy.add".into(),
                    target: rule.pattern.clone(),
                    decision: Some(rule.effect),
                    source: "user".into(),
                    thread_id: None,
                    run_id: None,
                    detail: serde_json::json!({ "kind": rule.kind, "engine": rule.engine }),
                },
            )?;
            tx.execute(
                "INSERT INTO policy_rules (id, effect, kind, pattern, engine, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    wire_name(rule.effect)?,
                    wire_name(rule.kind)?,
                    rule.pattern,
                    rule.engine,
                    rule.note,
                    stamp
                ],
            )?;
            Ok(())
        })?;
        Ok(PolicyRule {
            id,
            effect: rule.effect,
            kind: rule.kind,
            pattern: rule.pattern.clone(),
            engine: rule.engine.clone(),
            note: rule.note.clone(),
            created_at: stamp,
        })
    }

    pub fn delete_rule(&self, id: &str, actor: &str) -> Result<()> {
        self.commit(|tx, _| {
            let pattern: String = tx
                .query_row(
                    "SELECT pattern FROM policy_rules WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| CoreError::NotFound("policy rule".into()))?;
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "policy.delete".into(),
                    target: pattern,
                    decision: None,
                    source: "user".into(),
                    thread_id: None,
                    run_id: None,
                    detail: Value::Null,
                },
            )?;
            tx.execute("DELETE FROM policy_rules WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    pub fn list_profiles(&self) -> Result<Vec<SkillProfile>> {
        let conn = self.reader();
        let mut statement = conn.prepare("SELECT * FROM skill_profiles ORDER BY name")?;
        let rows = statement.query_map([], profile_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn profile(&self, id: &str) -> Result<Option<SkillProfile>> {
        Ok(self
            .reader()
            .query_row(
                "SELECT * FROM skill_profiles WHERE id = ?1",
                [id],
                profile_row,
            )
            .optional()?)
    }

    pub fn save_profile(&self, profile: &SkillProfile) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO skill_profiles (id, name, skills) VALUES (?1, ?2, ?3)
                 ON CONFLICT (id) DO UPDATE SET name = excluded.name, skills = excluded.skills",
                params![
                    profile.id,
                    profile.name,
                    serde_json::to_string(&profile.skills)?
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        self.commit(|tx, _| {
            let deleted = tx.execute("DELETE FROM skill_profiles WHERE id = ?1", [id])?;
            if deleted == 0 {
                return Err(CoreError::NotFound("skill profile".into()));
            }
            Ok(())
        })
    }

    pub fn list_custom_engines(&self) -> Result<Vec<CustomEngine>> {
        let conn = self.reader();
        let mut statement = conn.prepare("SELECT * FROM custom_engines ORDER BY name")?;
        let rows = statement.query_map([], engine_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn save_custom_engine(&self, engine: &CustomEngine, actor: &str) -> Result<()> {
        self.commit(|tx, _| {
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "engine.add".into(),
                    target: engine.target.clone(),
                    decision: None,
                    source: "user".into(),
                    thread_id: None,
                    run_id: None,
                    detail: serde_json::json!({ "id": engine.id, "tier": engine.tier }),
                },
            )?;
            tx.execute(
                "INSERT INTO custom_engines (id, name, tier, target, args)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (id) DO UPDATE SET name = excluded.name, tier = excluded.tier,
                    target = excluded.target, args = excluded.args",
                params![
                    engine.id,
                    engine.name,
                    wire_name(engine.tier)?,
                    engine.target,
                    serde_json::to_string(&engine.args)?
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_custom_engine(&self, id: &str, actor: &str) -> Result<()> {
        self.commit(|tx, _| {
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "engine.delete".into(),
                    target: id.to_owned(),
                    decision: None,
                    source: "user".into(),
                    thread_id: None,
                    run_id: None,
                    detail: Value::Null,
                },
            )?;
            let deleted = tx.execute("DELETE FROM custom_engines WHERE id = ?1", [id])?;
            if deleted == 0 {
                return Err(CoreError::NotFound("engine".into()));
            }
            Ok(())
        })
    }

    /// What an engine last said its slash commands are.
    pub fn engine_commands(&self, engine: &str) -> Result<Vec<(String, String)>> {
        Ok(self
            .setting(&format!("engine_commands:{engine}"))?
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default())
    }

    pub fn set_engine_commands(&self, engine: &str, commands: &[(String, String)]) -> Result<()> {
        self.set_setting(
            &format!("engine_commands:{engine}"),
            &serde_json::to_string(commands)?,
        )
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .reader()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }
}
