//! Named setups of an engine. One is stored in the `provider_instances` preference and
//! works as its own engine: threads pick it, and it keeps its own models and sessions.

use orbyn_contracts::{EngineTier, ProviderInstance};
use serde_json::Value;

use crate::error::{CoreError, Result};

const MAX_INSTANCES: usize = 32;
const MAX_ARGS: usize = 32;
const MAX_ARG: usize = 1024;

pub const PREFERENCE: &str = "provider_instances";
/// An instance supplies its command directly, without creating a second engine.
pub const LOCAL_ACP_DRIVER: &str = "_local_acp";

/// The stored list. A value that no longer parses starts nothing.
pub fn parse(value: &Value) -> Result<Vec<ProviderInstance>> {
    serde_json::from_value(value.clone())
        .map_err(|error| CoreError::Invalid(format!("That is not a provider instance: {error}.")))
}

fn plain_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Refuses a list that could not launch as written. `tier_of` gives a driver's tier,
/// or `None` for anything that is not an engine, which includes another instance.
pub fn check(
    list: &[ProviderInstance],
    tier_of: impl Fn(&str) -> Option<EngineTier>,
) -> Result<()> {
    if list.len() > MAX_INSTANCES {
        return Err(CoreError::Invalid(format!(
            "At most {MAX_INSTANCES} provider instances."
        )));
    }
    for (index, instance) in list.iter().enumerate() {
        let id = &instance.id;
        if !plain_id(id) {
            return Err(CoreError::Invalid(format!(
                "{id:?} is not a usable instance id: letters, digits, - and _ only."
            )));
        }
        if list[..index].iter().any(|earlier| earlier.id == *id) {
            return Err(CoreError::Invalid(format!("{id} is listed twice.")));
        }
        if tier_of(id).is_some() {
            return Err(CoreError::Invalid(format!("{id} is already an engine.")));
        }
        let base_tier = tier_of(&instance.driver);
        let local_acp = instance.driver == LOCAL_ACP_DRIVER && base_tier.is_none();
        // Old custom engines allowed arbitrary IDs. Do not reinterpret an existing
        // engine under this reserved name as the new command-only instance kind.
        if instance.driver == LOCAL_ACP_DRIVER && !local_acp {
            return Err(CoreError::Invalid(
                "The local ACP instance kind conflicts with an existing engine.".into(),
            ));
        }
        let tier = base_tier
            .or(local_acp.then_some(EngineTier::Acp))
            .ok_or_else(|| {
                CoreError::Invalid(format!(
                    "{id} runs {}, which is no engine.",
                    instance.driver
                ))
            })?;
        // A flag can switch off the gate, which rules 2, 3 and 8 depend on, and only
        // the native drivers are started with such flags. An ACP agent asks whatever
        // its arguments.
        if tier == EngineTier::Native && !instance.args.is_empty() {
            return Err(CoreError::Invalid(
                "Claude and Codex instances take a program, not arguments.".into(),
            ));
        }
        if (local_acp && instance.program.is_none())
            || instance
                .program
                .as_deref()
                .is_some_and(|p| p.trim().is_empty() || p.contains('\0') || p.len() > 4096)
        {
            return Err(CoreError::Invalid(format!("{id} names an empty program.")));
        }
        if instance.args.len() > MAX_ARGS
            || instance
                .args
                .iter()
                .any(|arg| arg.len() > MAX_ARG || arg.contains('\0'))
        {
            return Err(CoreError::Invalid(format!(
                "{id} has too many arguments, or one too long."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tier(id: &str) -> Option<EngineTier> {
        match id {
            "claude" => Some(EngineTier::Native),
            "kimi" => Some(EngineTier::Acp),
            _ => None,
        }
    }

    fn list(value: Value) -> Vec<ProviderInstance> {
        parse(&value).unwrap()
    }

    #[test]
    fn a_plain_instance_is_on_unless_it_says_otherwise() {
        let parsed = list(json!([{ "id": "work", "driver": "claude" }]));
        assert!(parsed[0].enabled);
        assert!(check(&parsed, tier).is_ok());
    }

    #[test]
    fn refuses_what_could_not_launch_as_written() {
        let refused = [
            json!([{ "id": "claude", "driver": "claude" }]),
            json!([{ "id": "a", "driver": "nothing" }]),
            json!([{ "id": "a/b", "driver": "claude" }]),
            json!([{ "id": "a", "driver": "claude" }, { "id": "a", "driver": "kimi" }]),
            json!([{ "id": "a", "driver": "claude", "program": " " }]),
            json!([{ "id": "a", "driver": "kimi", "args": ["x\u{0}"] }]),
        ];
        for value in refused {
            assert!(check(&list(value.clone()), tier).is_err(), "{value}");
        }
    }

    #[test]
    fn only_an_acp_style_engine_takes_arguments() {
        let flagged = list(json!([{ "id": "a", "driver": "claude", "args": ["--bare"] }]));
        assert!(check(&flagged, tier).is_err());
        let agent = list(json!([{ "id": "a", "driver": "kimi", "args": ["--profile", "x"] }]));
        assert!(check(&agent, tier).is_ok());
    }

    #[test]
    fn local_acp_instances_keep_their_own_executable_and_literal_arguments() {
        let local = list(json!([{
            "id": "local-work", "driver": "_local_acp", "program": "agent-command",
            "args": ["--profile", "work with spaces", ""]
        }]));
        assert!(check(&local, tier).is_ok());
        assert_eq!(local[0].args, ["--profile", "work with spaces", ""]);
        assert!(
            check(&local, |id| if id == LOCAL_ACP_DRIVER {
                Some(EngineTier::Acp)
            } else {
                tier(id)
            })
            .is_err(),
            "a legacy engine must not be silently reinterpreted"
        );
        for value in [
            json!([{ "id": "work", "driver": "_local_acp" }]),
            json!([{ "id": "work", "driver": "_local_acp", "program": " " }]),
            json!([{ "id": "work", "driver": "_local_acp", "program": "a\u{0}b" }]),
        ] {
            assert!(check(&list(value.clone()), tier).is_err(), "{value}");
        }
    }
}
