//! `orbyn`: the command line. Everything but `serve` goes to a running service through
//! the same API as the UI, so there is one owner of every rule. It finds the service
//! through `service.json` in the data folder, which the service writes at start, and
//! removes at exit.

use std::path::{Path, PathBuf};
use std::process::{Command as Process, ExitCode};
use std::time::{Duration, Instant};

use clap::{Args, Parser, Subcommand};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

/// How long `--wait` holds on for a run, and how often it looks.
const WAIT_LIMIT: Duration = Duration::from_secs(60 * 60);
const WAIT_POLL: Duration = Duration::from_millis(200);
const REPAIR_HINT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Parser)]
#[command(
    name = "orbyn",
    version,
    about = "Orbyn Engineering from the command line"
)]
struct Cli {
    /// The service's data folder. `ORBYN_DATA_DIR` sets it too.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// Print JSON instead of text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the service in this terminal, with `orbynd serve`'s options.
    Serve {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Whether a service is running, and what it is doing.
    Status,
    /// Check the database, and with `--fix` reclaim its free space.
    Doctor {
        #[arg(long)]
        fix: bool,
        /// Say what `--fix` would do. This is what a bare `doctor` does too.
        #[arg(long, conflicts_with = "fix")]
        dry_run: bool,
    },
    #[command(subcommand)]
    Thread(ThreadCommand),
    #[command(subcommand)]
    Project(ProjectCommand),
    #[command(subcommand)]
    Theme(ThemeCommand),
}

#[derive(Subcommand)]
enum ThreadCommand {
    /// Threads, newest activity first.
    List {
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        archived: bool,
    },
    /// Start a thread with a first message.
    Start(StartArgs),
    /// Queue a message on a thread.
    Send {
        thread: String,
        prompt: String,
        /// Stay until the run ends, and fail if it did not complete.
        #[arg(long)]
        wait: bool,
    },
    /// A thread and its messages.
    Show {
        thread: String,
        /// Stay until the run ends first.
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 200)]
        limit: usize,
    },
}

#[derive(Args)]
struct StartArgs {
    prompt: String,
    /// A project id. Absent starts in a new scratch folder.
    #[arg(long)]
    project: Option<String>,
    #[arg(long, default_value = "claude")]
    engine: String,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    wait: bool,
}

#[derive(Subcommand)]
enum ProjectCommand {
    List,
    /// Register a folder where it is. It starts untrusted.
    Add {
        path: PathBuf,
    },
    /// Unregister a project and delete its threads. The folder stays.
    Remove {
        project: String,
    },
    /// Change the name shown. The folder stays.
    Rename {
        project: String,
        name: String,
    },
}

#[derive(Subcommand)]
enum ThemeCommand {
    Show,
    Set { name: String },
    Clear,
}

/// A failure, with the exit code it ends in.
struct Failure {
    message: String,
    code: u8,
}

impl Failure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 1,
        }
    }

    /// A separate code, so a script can tell "nothing is running" from "it refused".
    fn not_running(detail: &str) -> Self {
        Self {
            message: format!("No Orbyn service is running{detail}. Start one with `orbyn serve`."),
            code: 2,
        }
    }
}

type Outcome<T> = Result<T, Failure>;

struct Service {
    url: String,
    token: String,
    client: reqwest::Client,
}

fn data_dir(cli: &Cli) -> Outcome<PathBuf> {
    cli.data_dir
        .clone()
        .or_else(orbyn_core::app::default_data_dir)
        .ok_or_else(|| Failure::new("Set --data-dir: no app-data folder could be found."))
}

impl Service {
    fn find(data: &Path) -> Outcome<Self> {
        let path = data.join("service.json");
        let text = std::fs::read_to_string(&path)
            .map_err(|_| Failure::not_running(&format!(" for {}", data.display())))?;
        let found: Value = serde_json::from_str(&text)
            .map_err(|_| Failure::new(format!("{} could not be read.", path.display())))?;
        let field = |key: &str| {
            found
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| Failure::new(format!("{} is incomplete.", path.display())))
        };
        Ok(Self {
            url: field("url")?,
            token: field("token")?,
            client: reqwest::Client::new(),
        })
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Outcome<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| Failure::not_running(" (the last one has stopped)"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(value);
        }
        let message = value.get("message").and_then(Value::as_str);
        Err(Failure::new(match (status, message) {
            (_, Some(message)) => message.to_owned(),
            (StatusCode::UNAUTHORIZED, None) => "The service refused this command.".to_owned(),
            (status, None) => format!("The service answered {status}."),
        }))
    }

    async fn get(&self, path: &str) -> Outcome<Value> {
        self.call(Method::GET, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Outcome<Value> {
        self.call(Method::POST, path, Some(body)).await
    }

    /// Waits for a thread's run to end, and returns how it ended.
    async fn wait(&self, thread: &str) -> Outcome<String> {
        let started = Instant::now();
        loop {
            let body = self.get(&format!("/api/threads/{thread}")).await?;
            if body["active_run"].is_null() {
                return Ok(body["last_run_state"].as_str().unwrap_or("none").to_owned());
            }
            if started.elapsed() > WAIT_LIMIT {
                return Err(Failure::new("Gave up waiting for that run."));
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
    }
}

fn encoded(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn print_thread(thread: &Value) {
    let state = if thread["active_run"].is_null() {
        text_of(thread, "last_run_state")
    } else {
        "running"
    };
    println!(
        "{}\t{}\t{}\t{}",
        text_of(thread, "id"),
        if state.is_empty() { "idle" } else { state },
        text_of(thread, "engine"),
        text_of(thread, "title"),
    );
}

fn print_project(project: &Value) {
    println!(
        "{}\t{}\t{}\t{}",
        text_of(project, "id"),
        if project["trusted"] == true {
            "trusted"
        } else {
            "untrusted"
        },
        text_of(project, "name"),
        text_of(project, "path"),
    );
}

/// Prints `value` as JSON, or through `text`.
fn show(json_output: bool, value: &Value, text: impl FnOnce(&Value)) -> Outcome<()> {
    if json_output {
        let printed =
            serde_json::to_string_pretty(value).map_err(|error| Failure::new(error.to_string()))?;
        println!("{printed}");
    } else {
        text(value);
    }
    Ok(())
}

/// Ends a command that waited, failing unless the run completed.
async fn finished(service: &Service, thread: &str, wait: bool) -> Outcome<()> {
    if !wait {
        return Ok(());
    }
    match service.wait(thread).await?.as_str() {
        "completed" => Ok(()),
        other => Err(Failure::new(format!("The run ended {other}."))),
    }
}

async fn thread_command(
    service: &Service,
    command: ThreadCommand,
    json_output: bool,
) -> Outcome<()> {
    match command {
        ThreadCommand::List { project, archived } => {
            let project =
                project.map_or_else(String::new, |id| format!("&project_id={}", encoded(&id)));
            let list = service
                .get(&format!("/api/threads?archived={archived}{project}"))
                .await?;
            show(json_output, &list, |list| {
                list.as_array().into_iter().flatten().for_each(print_thread);
            })
        }
        ThreadCommand::Start(args) => {
            let thread = service
                .post(
                    "/api/threads",
                    json!({
                        "project_id": args.project, "engine": args.engine, "model": null,
                        "title": args.title, "worktree": null, "skill_profile": null,
                    }),
                )
                .await?;
            let id = text_of(&thread, "id").to_owned();
            service
                .post(
                    &format!("/api/threads/{id}/queue"),
                    json!({ "prompt": args.prompt }),
                )
                .await?;
            show(json_output, &thread, |_| println!("{id}"))?;
            finished(service, &id, args.wait).await
        }
        ThreadCommand::Send {
            thread,
            prompt,
            wait,
        } => {
            let id = encoded(&thread);
            let queued = service
                .post(
                    &format!("/api/threads/{id}/queue"),
                    json!({ "prompt": prompt }),
                )
                .await?;
            show(json_output, &queued, |_| println!("queued"))?;
            finished(service, &id, wait).await
        }
        ThreadCommand::Show {
            thread,
            wait,
            limit,
        } => {
            let id = encoded(&thread);
            if wait {
                service.wait(&id).await?;
            }
            let body = service.get(&format!("/api/threads/{id}")).await?;
            let messages = service
                .get(&format!("/api/threads/{id}/messages?limit={limit}"))
                .await?;
            let both = json!({ "thread": body, "messages": messages });
            show(json_output, &both, |both| {
                print_thread(&both["thread"]);
                for message in both["messages"].as_array().into_iter().flatten() {
                    println!(
                        "\n[{}]\n{}",
                        text_of(message, "role"),
                        text_of(message, "text")
                    );
                }
            })
        }
    }
}

async fn project_command(
    service: &Service,
    command: ProjectCommand,
    json_output: bool,
) -> Outcome<()> {
    let printed = match command {
        ProjectCommand::List => {
            let list = service.get("/api/projects").await?;
            return show(json_output, &list, |list| {
                list.as_array()
                    .into_iter()
                    .flatten()
                    .for_each(print_project);
            });
        }
        ProjectCommand::Add { path } => {
            let path = std::path::absolute(&path)
                .map_err(|error| Failure::new(format!("That path is not usable: {error}")))?;
            service
                .post("/api/projects/add", json!({ "path": path }))
                .await?
        }
        ProjectCommand::Remove { project } => {
            let path = format!("/api/projects/{}", encoded(&project));
            return service
                .call(Method::DELETE, &path, None)
                .await
                .and_then(|removed| show(json_output, &removed, |_| println!("removed")));
        }
        ProjectCommand::Rename { project, name } => {
            let path = format!("/api/projects/{}", encoded(&project));
            service
                .call(Method::PATCH, &path, Some(json!({ "name": name })))
                .await?
        }
    };
    let project = printed.get("project").unwrap_or(&printed).clone();
    show(json_output, &project, print_project)
}

async fn theme_command(service: &Service, command: ThemeCommand, json_output: bool) -> Outcome<()> {
    let value = match command {
        ThemeCommand::Show => {
            let views = service.get("/api/preferences").await?;
            views
                .as_array()
                .into_iter()
                .flatten()
                .find(|view| view["key"] == "default_theme")
                .map_or(Value::Null, |view| view["value"].clone())
        }
        ThemeCommand::Set { name } => {
            set_theme(service, json!(name)).await?;
            json!(name)
        }
        ThemeCommand::Clear => {
            set_theme(service, Value::Null).await?;
            json!("")
        }
    };
    show(json_output, &value, |value| {
        println!("{}", value.as_str().unwrap_or(""));
    })
}

async fn set_theme(service: &Service, value: Value) -> Outcome<()> {
    let body = json!({ "values": { "default_theme": value } });
    service
        .call(Method::PUT, "/api/preferences", Some(body))
        .await
        .map(|_| ())
}

async fn status(cli: &Cli) -> Outcome<()> {
    let service = Service::find(&data_dir(cli)?)?;
    let info = service.get("/api/info").await?;
    let diagnostics = service.get("/api/diagnostics").await?;
    let workspace = service.get("/api/workspace").await?;
    let summary = json!({
        "url": service.url,
        "version": info["version"],
        "remote": info["remote"],
        "pid": diagnostics["pid"],
        "active_runs": diagnostics["active_runs"],
        "terminals": diagnostics["terminals"],
        "workspace_configured": workspace["configured"],
    });
    show(cli.json, &summary, |summary| {
        println!(
            "Running at {} (version {})",
            service.url,
            text_of(summary, "version")
        );
        println!(
            "{} active runs, {} terminals",
            summary["active_runs"], summary["terminals"]
        );
    })
}

async fn doctor(cli: &Cli, fix: bool) -> Outcome<()> {
    let service = Service::find(&data_dir(cli)?)?;
    let before = service.get("/api/diagnostics").await?;
    let free = before["database"]["reclaimable_bytes"]
        .as_u64()
        .unwrap_or(0);
    if fix {
        service.post("/api/diagnostics/repair", json!({})).await?;
    }
    let after = service.get("/api/diagnostics").await?;
    let report =
        json!({ "repaired": fix, "before": before["database"], "after": after["database"] });
    show(cli.json, &report, |_| {
        if fix {
            println!("Repaired. {free} bytes were free before.");
        } else if free >= REPAIR_HINT_BYTES {
            println!("{free} bytes could be reclaimed. Run `orbyn doctor --fix`.");
        } else {
            println!("Nothing needs fixing: {free} bytes reclaimable.");
        }
    })
}

/// `orbynd` sits beside this program in every install.
fn run_service(args: &[String], data: Option<&Path>) -> Outcome<()> {
    let name = if cfg!(windows) {
        "orbynd.exe"
    } else {
        "orbynd"
    };
    let beside = std::env::current_exe()
        .ok()
        .and_then(|program| program.parent().map(|folder| folder.join(name)))
        .filter(|path| path.is_file())
        .ok_or_else(|| Failure::new("orbynd was not found beside this program."))?;
    let mut command = Process::new(beside);
    command.arg("serve").args(args);
    if let Some(data) = data {
        command.arg("--data-dir").arg(data);
    }
    let status = command
        .status()
        .map_err(|error| Failure::new(format!("orbynd did not start: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(Failure::new("The service stopped with an error."))
    }
}

async fn run(cli: Cli) -> Outcome<()> {
    match &cli.command {
        Command::Serve { args } => return run_service(args, cli.data_dir.as_deref()),
        Command::Status => return status(&cli).await,
        Command::Doctor { fix, .. } => return doctor(&cli, *fix).await,
        _ => {}
    }
    let service = Service::find(&data_dir(&cli)?)?;
    let json_output = cli.json;
    match cli.command {
        Command::Thread(command) => thread_command(&service, command, json_output).await,
        Command::Project(command) => project_command(&service, command, json_output).await,
        Command::Theme(command) => theme_command(&service, command, json_output).await,
        Command::Serve { .. } | Command::Status | Command::Doctor { .. } => Ok(()),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            eprintln!("{}", failure.message);
            ExitCode::from(failure.code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_change_the_path_they_go_into() {
        assert_eq!(encoded("a/../b c"), "a%2F..%2Fb%20c");
    }
}
