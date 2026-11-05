//! Claude Code's own background workflows (its `Workflow` tool). The tool result
//! names the task the CLI runs in the background and the script it runs; the CLI
//! then reports the task's end with `task_notification`. Observed on Claude Code
//! 2.1.318: the turn's `result` arrives while the workflow still runs, a finished
//! workflow starts a follow-up turn, and a `stop_task` control request ends it
//! with status `stopped` and no follow-up turn.

use std::collections::HashMap;

use orbyn_contracts::AgUiEvent;
use serde_json::{Value, json};

use super::super::{EngineEvent, ItemRecord, workflow_item_id};
use super::text_of;

const TASK_TYPE: &str = "local_workflow";
/// Control request ids the driver sends to stop a workflow start with this.
const STOP_PREFIX: &str = "orbyn-stop-";

#[derive(Clone, Debug)]
struct Task {
    tool_call_id: String,
    task_id: String,
    name: Option<String>,
    script_path: Option<String>,
}

/// The workflows this run launched that are still running.
#[derive(Default)]
pub struct Workflows {
    running: HashMap<String, Task>,
}

impl Workflows {
    pub fn is_empty(&self) -> bool {
        self.running.is_empty()
    }

    /// A top-level tool result that launched a workflow.
    pub fn launched(&mut self, frame: &Value) -> Vec<EngineEvent> {
        let Some(result) = frame.get("tool_use_result") else {
            return Vec::new();
        };
        if text_of(result, "taskType").as_deref() != Some(TASK_TYPE)
            || text_of(result, "status").as_deref() != Some("async_launched")
        {
            return Vec::new();
        }
        let Some(task_id) = text_of(result, "taskId") else {
            return Vec::new();
        };
        let tool_call_id = frame
            .pointer("/message/content")
            .and_then(Value::as_array)
            .and_then(|content| {
                content.iter().find_map(|block| {
                    (block.get("type").and_then(Value::as_str) == Some("tool_result"))
                        .then(|| text_of(block, "tool_use_id"))
                        .flatten()
                })
            });
        let Some(tool_call_id) = tool_call_id else {
            return Vec::new();
        };
        let task = Task {
            tool_call_id: tool_call_id.clone(),
            task_id,
            name: text_of(result, "workflowName"),
            script_path: text_of(result, "scriptPath"),
        };
        let events = state_events(&task, "running");
        self.running.insert(tool_call_id, task);
        events
    }

    /// A `task_notification`, or a `task_updated` that ends a task.
    pub fn system(&mut self, frame: &Value) -> Vec<EngineEvent> {
        let status = match frame.get("subtype").and_then(Value::as_str) {
            Some("task_notification") => text_of(frame, "status"),
            Some("task_updated") => frame
                .pointer("/patch/status")
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => None,
        };
        let state = match status.as_deref() {
            Some("completed") => "completed",
            Some("failed") => "failed",
            Some("stopped" | "killed") => "stopped",
            _ => return Vec::new(),
        };
        let Some(task_id) = text_of(frame, "task_id") else {
            return Vec::new();
        };
        let Some(tool) = self
            .running
            .iter()
            .find(|(_, task)| task.task_id == task_id)
            .map(|(tool, _)| tool.clone())
        else {
            return Vec::new();
        };
        let Some(task) = self.running.remove(&tool) else {
            return Vec::new();
        };
        state_events(&task, state)
    }

    /// The control request that stops the workflow this tool call launched, while
    /// it runs.
    pub fn stop_request(&self, tool_call_id: &str) -> Option<String> {
        let task = self.running.get(tool_call_id)?;
        Some(
            json!({
                "type": "control_request",
                "request_id": format!("{STOP_PREFIX}{tool_call_id}"),
                "request": { "subtype": "stop_task", "task_id": task.task_id },
            })
            .to_string(),
        )
    }

    /// The CLI's answer to a stop. Only a refusal is shown; the task's end
    /// arrives on its own.
    pub fn control_response(frame: &Value) -> Vec<EngineEvent> {
        let Some(response) = frame.get("response") else {
            return Vec::new();
        };
        let Some(tool_call_id) = response
            .get("request_id")
            .and_then(Value::as_str)
            .and_then(|id| id.strip_prefix(STOP_PREFIX))
        else {
            return Vec::new();
        };
        if response.get("subtype").and_then(Value::as_str) != Some("error") {
            return Vec::new();
        }
        vec![
            AgUiEvent::Custom {
                name: "workflow.stop_failed".into(),
                value: json!({
                    "toolCallId": tool_call_id,
                    "message": "Claude Code did not stop the workflow.",
                }),
            }
            .into(),
        ]
    }
}

fn state_events(task: &Task, state: &str) -> Vec<EngineEvent> {
    vec![
        EngineEvent::Item(ItemRecord {
            id: workflow_item_id(&task.tool_call_id),
            kind: "workflow".into(),
            raw: json!({
                "toolCallId": task.tool_call_id,
                "taskId": task.task_id,
                "name": task.name,
                "scriptPath": task.script_path,
                "state": state,
            }),
            exit_code: None,
        }),
        AgUiEvent::Custom {
            name: "workflow.state".into(),
            value: json!({
                "toolCallId": task.tool_call_id,
                "name": task.name,
                "state": state,
            }),
        }
        .into(),
    ]
}
