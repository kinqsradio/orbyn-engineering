//! Runs the real `orbynd` binary against the fake engine over real processes.

#![allow(dead_code)]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};

pub const FAKE: &str = env!("CARGO_BIN_EXE_orbyn-fake-engine");
const ORBYND: &str = env!("CARGO_BIN_EXE_orbynd");

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("orbynd-test-{}", orbyn_core::util::new_id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(std::fs::canonicalize(path).unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
pub struct Options {
    pub env: Vec<(String, String)>,
    pub args: Vec<String>,
    pub skills: Option<PathBuf>,
}

pub struct Service {
    pub url: String,
    pub token: String,
    pub access_key: Option<String>,
    pub client: reqwest::Client,
    pub child: Child,
}

impl Service {
    pub fn start(data: &Path, options: Options) -> Self {
        Self::try_start(data, options).expect("service should start")
    }

    pub fn try_start(data: &Path, options: Options) -> Result<Self, String> {
        let mut command = Command::new(ORBYND);
        command
            .args(["serve", "--data-dir"])
            .arg(data)
            .args(&options.args)
            .env("ORBYN_CLAUDE_BIN", FAKE)
            .env("ORBYN_CODEX_BIN", FAKE)
            .env("ORBYN_OFFLINE", "1")
            .env_remove("ORBYN_SKILLS_DIR")
            .current_dir(data.parent().unwrap_or(data))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Without an explicit source the service would find the real library
        // above this checkout and build a pack from it.
        let skills = options
            .skills
            .clone()
            .unwrap_or_else(|| data.join("no-skills"));
        command.arg("--skills-dir").arg(skills);
        for (key, value) in &options.env {
            command.env(key, value);
        }
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        if line.is_empty() {
            let mut text = String::new();
            std::io::Read::read_to_string(child.stderr.as_mut().unwrap(), &mut text).unwrap();
            let _ = child.wait();
            return Err(text);
        }
        let start: Value = serde_json::from_str(&line).unwrap();
        Ok(Self {
            url: start["url"].as_str().unwrap().to_owned(),
            token: start["token"].as_str().unwrap().to_owned(),
            access_key: start["access_key"].as_str().map(str::to_owned),
            client: reqwest::Client::new(),
            child,
        })
    }

    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
    }

    pub async fn json(&self, path: &str) -> Value {
        let response = self.get(path).send().await.unwrap();
        assert!(
            response.status().is_success(),
            "{path}: {}",
            response.status()
        );
        response.json().await.unwrap()
    }

    pub async fn send(&self, path: &str, body: Value) -> (u16, Value) {
        let response = self.post(path).json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn project(&self, path: &Path, trusted: bool) -> String {
        let (status, project) = self.send("/api/projects", json!({ "path": path })).await;
        assert_eq!(status, 201, "{project}");
        let id = project["id"].as_str().unwrap().to_owned();
        if trusted {
            let (status, _) = self
                .send(&format!("/api/projects/{id}/trust"), json!({}))
                .await;
            assert_eq!(status, 200);
        }
        id
    }

    pub async fn thread(&self, project: &str, engine: &str) -> String {
        let (status, thread) = self
            .send(
                "/api/threads",
                json!({
                    "project_id": project, "engine": engine, "model": null, "title": null,
                    "worktree": null, "skill_profile": null,
                }),
            )
            .await;
        assert_eq!(status, 201, "{thread}");
        thread["id"].as_str().unwrap().to_owned()
    }

    pub async fn admit(&self, thread: &str, prompt: &str) -> String {
        let (status, run) = self
            .send(
                &format!("/api/threads/{thread}/runs"),
                json!({ "prompt": prompt }),
            )
            .await;
        assert_eq!(status, 202, "{run}");
        run["id"].as_str().unwrap().to_owned()
    }

    pub async fn run_state(&self, thread: &str) -> Value {
        let thread = self.json(&format!("/api/threads/{thread}")).await;
        thread["last_run_state"].clone()
    }

    /// Waits for the thread's latest run to reach a terminal state.
    pub async fn finished(&self, thread: &str) -> String {
        for _ in 0..1500 {
            let thread_body = self.json(&format!("/api/threads/{thread}")).await;
            if thread_body["active_run"].is_null() {
                return thread_body["last_run_state"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("run did not finish");
    }

    pub async fn pending(&self) -> Value {
        for _ in 0..1000 {
            let approvals = self.json("/api/approvals?state=pending").await;
            if approvals.as_array().is_some_and(|list| !list.is_empty()) {
                return approvals[0].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no approval appeared");
    }

    pub async fn decide(&self, approval: &str, allow: bool) -> (u16, Value) {
        self.send(
            &format!("/api/approvals/{approval}/decide"),
            json!({ "allow": allow, "remember": false }),
        )
        .await
    }

    /// Reads SSE frames until `stop` matches, up to a limit.
    pub async fn events_until(
        &self,
        thread: &str,
        after: Option<i64>,
        stop: impl Fn(&Value) -> bool,
    ) -> Vec<Value> {
        let mut request = self
            .get(&format!("/api/threads/{thread}/events"))
            .header("Accept", "text/event-stream");
        if let Some(after) = after {
            request = request.header("Last-Event-ID", after.to_string());
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 200);
        let mut body = response.bytes_stream();
        let mut parser = orbyn_core::sse::SseParser::default();
        let mut events = Vec::new();
        loop {
            let chunk = tokio::time::timeout(Duration::from_secs(15), body.next())
                .await
                .expect("event stream stalled")
                .expect("event stream ended")
                .unwrap();
            for frame in parser.push(&chunk) {
                let event: Value = serde_json::from_str(&frame).unwrap();
                let done = stop(&event);
                events.push(event);
                if done {
                    return events;
                }
            }
        }
    }

    pub async fn all_events(&self, thread: &str) -> Vec<Value> {
        self.events_until(thread, None, |event| {
            matches!(
                event["event"]["type"].as_str(),
                Some("RUN_FINISHED" | "RUN_ERROR")
            )
        })
        .await
    }

    pub async fn audit(&self, thread: &str) -> Vec<Value> {
        self.json(&format!("/api/audit?thread_id={thread}&limit=200"))
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    /// Asks for a graceful exit by closing the parent pipe or sending SIGTERM.
    pub async fn stop(mut self) {
        #[cfg(unix)]
        {
            let pid = self.child.id().to_string();
            let _ = Command::new("kill").args(["-TERM", &pid]).status();
        }
        for _ in 0..1000 {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn text_of(events: &[Value]) -> String {
    events
        .iter()
        .filter(|event| event["event"]["type"] == "TEXT_MESSAGE_CONTENT")
        .filter(|event| {
            !event["event"]["messageId"]
                .as_str()
                .unwrap_or_default()
                .ends_with(":prompt")
        })
        .filter_map(|event| event["event"]["delta"].as_str())
        .collect()
}

pub fn types_of(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event["event"]["type"].as_str().map(str::to_owned))
        .collect()
}

/// A trusted project with a thread on `engine`.
pub async fn setup(dir: &TempDir, options: Options, engine: &str) -> (Service, String) {
    let service = Service::start(&dir.path().join("data"), options);
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, true).await;
    let thread = service.thread(&project, engine).await;
    (service, thread)
}
