//! An ACP agent's own saved sessions, managed through the real service against the
//! protocol double. The double keeps its sessions in a file, so every operation is
//! a fresh process that reads what earlier ones changed.

mod support;

use std::path::Path;

use serde_json::{Value, json};
use support::*;

const FAKE: &str = env!("CARGO_BIN_EXE_orbyn-fake-engine");

async fn put_preferences(service: &Service, body: Value) -> (u16, Value) {
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&body)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

fn update(kind: &str, text: &str) -> Value {
    json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}})
}

fn session(id: &str, cwd: &str, title: &str) -> Value {
    json!({
        "sessionId": id, "cwd": cwd, "title": title, "updatedAt": "2026-11-01T00:00:00Z",
        "history": [update("user_message_chunk", "earlier question"), update("agent_message_chunk", "earlier answer")],
    })
}

fn launches(path: &Path, mode: &str) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|entry| entry["mode"] == mode)
        .collect()
}

fn stored(native: &Path) -> Vec<String> {
    let rows: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(native.join("sessions.json")).unwrap())
            .unwrap();
    rows.iter()
        .map(|row| row["sessionId"].as_str().unwrap().to_owned())
        .collect()
}

struct World {
    dir: TempDir,
    service: Service,
    project: String,
    path: String,
    native: std::path::PathBuf,
    launch: std::path::PathBuf,
}

async fn world(extra: &[(&str, &str)]) -> World {
    let dir = TempDir::new();
    let native = dir.path().join("native");
    std::fs::create_dir_all(&native).unwrap();
    let launch = dir.path().join("launches");
    let mut env = vec![
        (
            "ORBYN_FAKE_ACP_NATIVE".to_owned(),
            native.to_string_lossy().into_owned(),
        ),
        (
            "ORBYN_FAKE_LAUNCH_FILE".to_owned(),
            launch.to_string_lossy().into_owned(),
        ),
    ];
    env.extend(
        extra
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
    );
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            env,
            ..Options::default()
        },
    );
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, true).await;
    let path = service.json("/api/projects").await[0]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    std::fs::write(
        native.join("sessions.json"),
        Value::Array(vec![
            session("s1", &path, "First chat"),
            session("s2", &path, "Second chat"),
            session("s3", &path, "Third chat"),
            session("elsewhere", "/somewhere/else", "Not this project"),
        ])
        .to_string(),
    )
    .unwrap();
    let (code, body) = put_preferences(
        &service,
        json!({"values": {"provider_instances": [
            {"id": "agent", "driver": "_local_acp", "name": "Agent", "program": FAKE, "args": ["acp"]},
            {"id": "off", "driver": "_local_acp", "program": FAKE, "args": ["acp"], "enabled": false},
        ]}}),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    World {
        dir,
        service,
        project,
        path,
        native,
        launch,
    }
}

impl World {
    async fn list(&self, engine: &str, cursor: Option<&str>) -> (u16, Value) {
        let mut url = format!(
            "/api/engines/{engine}/native-sessions?project_id={}",
            self.project
        );
        if let Some(cursor) = cursor {
            url += &format!("&cursor={cursor}");
        }
        let response = self.service.get(&url).send().await.unwrap();
        (
            response.status().as_u16(),
            response.json().await.unwrap_or(Value::Null),
        )
    }
    async fn import(&self, engine: &str, session: &str) -> (u16, Value) {
        self.service
            .send(
                &format!("/api/engines/{engine}/native-sessions/import"),
                json!({"project_id": self.project, "session_id": session, "title": "Client title"}),
            )
            .await
    }
    async fn delete(&self, engine: &str, session: &str) -> (u16, Value) {
        self.service
            .send(
                &format!("/api/engines/{engine}/native-sessions/delete"),
                json!({"project_id": self.project, "session_id": session}),
            )
            .await
    }
    async fn threads(&self) -> usize {
        self.service
            .json("/api/threads")
            .await
            .as_array()
            .unwrap()
            .len()
    }
}

#[tokio::test]
async fn sessions_are_listed_imported_continued_and_deleted() {
    let w = world(&[]).await;
    let (code, caps) = w
        .service
        .get("/api/engines/agent/native-sessions/capabilities")
        .send()
        .await
        .map(|r| (r.status().as_u16(), r))
        .unwrap();
    assert_eq!(code, 200);
    let caps: Value = caps.json().await.unwrap();
    assert_eq!(
        caps,
        json!({"can_list": true, "can_load": true, "can_resume": false, "can_delete": true})
    );

    let (code, first) = w.list("agent", None).await;
    assert_eq!(code, 200, "{first}");
    assert_eq!(first["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(first["next_cursor"], "2");
    let (_, second) = w.list("agent", Some("2")).await;
    assert_eq!(second["sessions"][0]["session_id"], "s3");
    assert!(
        second["next_cursor"].is_null(),
        "the other folder's session is not offered"
    );
    // The agent is asked about the registered folder and is never launched in it.
    for entry in launches(&w.launch, "acp-list") {
        assert_eq!(
            serde_json::from_str::<Value>(entry["args"][0].as_str().unwrap()).unwrap()["cwd"],
            w.path
        );
    }
    for entry in launches(&w.launch, "acp") {
        assert_ne!(
            entry["cwd"],
            json!(w.path),
            "management never runs in the project folder"
        );
    }
    assert!(
        launches(&w.launch, "acp-model").is_empty(),
        "no prompt or model change"
    );

    let (code, imported) = w.import("agent", "s1").await;
    assert_eq!(code, 200, "{imported}");
    assert_eq!(imported["imported"], true);
    let thread = imported["thread_id"].as_str().unwrap().to_owned();
    let body = w.service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(
        body["title"], "First chat",
        "the agent's title wins over the client's"
    );
    assert_eq!(body["engine"], "agent");
    assert!(body["active_run"].is_null());
    let history = w
        .service
        .events_until(&thread, None, |e| {
            e["event"]["type"] == "TEXT_MESSAGE_END" && e["event"]["messageId"] == "acp-history-2"
        })
        .await;
    assert_eq!(text_of(&history), "earlier questionearlier answer");
    let roles: Vec<&str> = history
        .iter()
        .filter(|e| e["event"]["type"] == "TEXT_MESSAGE_START")
        .map(|e| e["event"]["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["user", "assistant"]);

    let (_, again) = w.import("agent", "s1").await;
    assert_eq!(again, json!({"thread_id": thread, "imported": false}));
    assert_eq!(w.threads().await, 1, "importing twice makes one thread");
    let (_, relisted) = w.list("agent", None).await;
    assert_eq!(relisted["sessions"][0]["imported_thread_id"], thread);
    assert!(relisted["sessions"][1]["imported_thread_id"].is_null());

    // A new turn continues the saved session and does not replay it into the thread.
    let loads = launches(&w.launch, "acp-load").len();
    w.service.admit(&thread, "continue").await;
    assert_eq!(w.service.finished(&thread).await, "completed");
    assert!(launches(&w.launch, "acp-load").len() > loads);
    let all = w.service.all_events(&thread).await;
    let text = text_of(&all);
    assert_eq!(text.matches("earlier answer").count(), 1, "{text}");
    assert!(text.contains("hello from acp"), "{text}");

    // The thread holds s1; s2 may go.
    let (code, body) = w.delete("agent", "s1").await;
    assert_eq!(code, 400, "{body}");
    assert!(stored(&w.native).contains(&"s1".to_owned()));
    let (code, _) = w.delete("agent", "s2").await;
    assert_eq!(code, 204);
    assert_eq!(stored(&w.native), ["s1", "s3", "elsewhere"]);
    let (_, after) = w.list("agent", None).await;
    assert_eq!(after["sessions"].as_array().unwrap().len(), 2);
    drop(w.dir);
}

#[tokio::test]
async fn a_session_the_project_does_not_list_is_neither_imported_nor_deleted() {
    let w = world(&[]).await;
    for id in ["elsewhere", "missing"] {
        let (code, body) = w.import("agent", id).await;
        assert_eq!(code, 404, "{body}");
        let (code, body) = w.delete("agent", id).await;
        assert_eq!(code, 404, "{body}");
    }
    assert_eq!(w.threads().await, 0);
    assert_eq!(stored(&w.native).len(), 4);
    assert!(
        launches(&w.launch, "acp-delete").is_empty(),
        "no delete reached the agent"
    );
    assert!(
        launches(&w.launch, "acp-load").is_empty(),
        "no history was loaded"
    );
}

#[tokio::test]
async fn the_request_cannot_choose_the_folder_or_exceed_the_contract() {
    let w = world(&[]).await;
    let (code, _) = w
        .service
        .send(
            "/api/engines/agent/native-sessions/import",
            json!({"project_id": w.project, "session_id": "s1", "cwd": "/"}),
        )
        .await;
    assert!(code >= 400 && code < 500, "{code}");
    let response = w
        .service
        .get(&format!(
            "/api/engines/agent/native-sessions?project_id={}&cwd=/",
            w.project
        ))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_client_error());
    let (code, _) = w
        .service
        .send(
            "/api/engines/agent/native-sessions/delete",
            json!({"project_id": "nope", "session_id": "s1"}),
        )
        .await;
    assert_eq!(code, 404);
    assert!(launches(&w.launch, "acp-list").is_empty());
}

#[tokio::test]
async fn untrusted_projects_and_unavailable_engines_are_refused_without_launching() {
    let w = world(&[]).await;
    let folder = w.dir.path().join("other");
    std::fs::create_dir_all(&folder).unwrap();
    let other = w.service.project(&folder, false).await;
    let response = w
        .service
        .get(&format!(
            "/api/engines/agent/native-sessions?project_id={other}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let (code, _) = w.list("off", None).await;
    assert_eq!(code, 400, "a turned-off instance is not managed");
    let (code, _) = w.list("claude", None).await;
    assert_eq!(code, 422, "a native engine has no ACP sessions");
    let (code, _) = w.list("no-such", None).await;
    assert_eq!(code, 404);
    assert!(launches(&w.launch, "acp-list").is_empty());
}

#[tokio::test]
async fn an_agent_without_session_support_offers_none() {
    // The same double without its native-session directory advertises nothing.
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, true).await;
    let (code, _) = put_preferences(
        &service,
        json!({"values": {"provider_instances": [{"id": "plain", "driver": "_local_acp", "program": FAKE, "args": ["acp"]}]}}),
    )
    .await;
    assert_eq!(code, 200);
    let caps: Value = service
        .get("/api/engines/plain/native-sessions/capabilities")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        caps,
        json!({"can_list": false, "can_load": false, "can_resume": false, "can_delete": false})
    );
    let response = service
        .get(&format!(
            "/api/engines/plain/native-sessions?project_id={project}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);
    let (code, _) = service
        .send(
            "/api/engines/plain/native-sessions/import",
            json!({"project_id": project, "session_id": "s1"}),
        )
        .await;
    assert_eq!(code, 422);
}

#[tokio::test]
async fn a_running_operation_excludes_changes_to_its_command_and_its_own_runs() {
    let w = world(&[("ORBYN_FAKE_ACP_LIST_DELAY_MS", "2500")]).await;
    let thread = w.service.thread(&w.project, "agent").await;
    let before = w.service.json("/api/preferences").await;
    let rival = async {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let second = w.list("agent", None).await.0;
        let (changed, _) = put_preferences(
            &w.service,
            json!({"values": {"provider_instances": [
                {"id": "agent", "driver": "_local_acp", "program": "/replaced", "args": []},
            ]}}),
        )
        .await;
        let (admitted, _) = w
            .service
            .send(
                &format!("/api/threads/{thread}/runs"),
                json!({"prompt": "now"}),
            )
            .await;
        (second, changed, admitted)
    };
    let ((first, _), (second, changed, admitted)) = tokio::join!(w.list("agent", None), rival);
    assert_eq!(first, 200, "the operation itself completes");
    assert_eq!(second, 409, "one operation per instance");
    assert_eq!(changed, 409, "its command cannot be replaced meanwhile");
    assert_eq!(admitted, 409, "its runs wait for the operation");
    assert_eq!(w.service.json("/api/preferences").await, before);
    // Once settled the same changes and runs are accepted.
    w.service.admit(&thread, "now").await;
    assert_eq!(w.service.finished(&thread).await, "completed");
}
