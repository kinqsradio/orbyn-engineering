//! Checks `AgUiEvent` against AG-UI 1.0. The fixture is derived from the spec's
//! `schema.json`; when the upstream checkout is present, its published valid
//! fixtures are parsed as well.

use std::collections::BTreeSet;
use std::path::PathBuf;

use orbyn_contracts::AgUiEvent;
use serde_json::{Value, json};

fn spec() -> Value {
    serde_json::from_str(include_str!("fixtures/agui-1.0-events.json")).unwrap()
}

/// One value of every variant, with every optional field populated.
fn samples() -> Vec<AgUiEvent> {
    let id = || "id".to_owned();
    vec![
        AgUiEvent::RunStarted {
            thread_id: id(),
            run_id: id(),
        },
        AgUiEvent::RunFinished {
            thread_id: id(),
            run_id: id(),
            outcome: Some(json!({ "type": "success" })),
        },
        AgUiEvent::RunError {
            message: id(),
            code: Some(id()),
        },
        AgUiEvent::TextMessageStart {
            message_id: id(),
            role: "assistant".into(),
        },
        AgUiEvent::TextMessageContent {
            message_id: id(),
            delta: id(),
        },
        AgUiEvent::TextMessageEnd { message_id: id() },
        AgUiEvent::ReasoningMessageStart {
            message_id: id(),
            role: "reasoning".into(),
        },
        AgUiEvent::ReasoningMessageContent {
            message_id: id(),
            delta: id(),
        },
        AgUiEvent::ReasoningMessageEnd { message_id: id() },
        AgUiEvent::ToolCallStart {
            tool_call_id: id(),
            tool_call_name: id(),
        },
        AgUiEvent::ToolCallArgs {
            tool_call_id: id(),
            delta: id(),
        },
        AgUiEvent::ToolCallEnd { tool_call_id: id() },
        AgUiEvent::ToolCallResult {
            message_id: id(),
            tool_call_id: id(),
            content: id(),
            role: Some("tool".into()),
        },
        AgUiEvent::ActivitySnapshot {
            message_id: id(),
            activity_type: id(),
            content: json!({}),
            replace: Some(true),
        },
        AgUiEvent::Custom {
            name: id(),
            value: json!(1),
        },
        AgUiEvent::Raw {
            event: json!({}),
            source: Some(id()),
        },
    ]
}

fn names(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn every_variant_uses_only_spec_fields_and_all_required_ones() {
    let spec = spec();
    let events = spec["events"].as_object().unwrap();
    let samples = samples();
    assert_eq!(
        samples.len(),
        events.len(),
        "variant set differs from the fixture"
    );
    for sample in samples {
        let value = serde_json::to_value(&sample).unwrap();
        let kind = value["type"].as_str().unwrap();
        let schema = &events[kind];
        let fields: BTreeSet<String> = value.as_object().unwrap().keys().cloned().collect();
        let allowed = names(&schema["properties"]);
        let required = names(&schema["required"]);
        assert!(
            fields.is_subset(&allowed),
            "{kind}: {fields:?} not in {allowed:?}"
        );
        assert!(required.is_subset(&fields), "{kind}: missing {required:?}");
        for (field, constant) in schema["consts"].as_object().unwrap() {
            assert_eq!(&value[field], constant, "{kind}.{field}");
        }
    }
}

#[test]
fn run_outcomes_are_the_spec_set() {
    assert_eq!(
        spec()["outcomes"],
        json!(["cancelled", "interrupt", "success"])
    );
}

#[test]
fn published_valid_fixtures_parse_when_the_spec_is_present() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../../../orbyn-references/desktop-agent-product-2026-10-31/ag-ui/spec/1.0/fixtures",
    );
    if !root.is_dir() {
        return;
    }
    let spec = spec();
    let mut parsed = 0;
    for entry in std::fs::read_dir(root).unwrap() {
        let valid = entry.unwrap().path().join("valid");
        let Ok(files) = std::fs::read_dir(valid) else {
            continue;
        };
        for file in files {
            let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(kind) = value.get("type").and_then(Value::as_str) else {
                continue;
            };
            if spec["events"].get(kind).is_none() {
                continue;
            }
            // Fields the spec lets a consumer default are not required on input,
            // and some producers send content as parts; drivers normalize those.
            if (kind == "TEXT_MESSAGE_START" && value.get("role").is_none())
                || (kind == "TOOL_CALL_RESULT" && value["content"].is_array())
            {
                continue;
            }
            let event: Result<AgUiEvent, _> = serde_json::from_value(value.clone());
            assert!(event.is_ok(), "{kind}: {value}: {event:?}");
            parsed += 1;
        }
    }
    assert!(parsed > 20, "only {parsed} fixtures were checked");
}
