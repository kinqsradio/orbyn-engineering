//! `orbyn`: the command line. Everything but `serve` goes to a running service through
//! the same API as the UI, so there is one owner of every rule. It finds the service
//! through `service.json` in the data folder, which the service writes at start, and
//! removes at exit.

#[path = "../cli_service.rs"]
mod cli_service;
#[path = "../cli_trace.rs"]
mod cli_trace;

use std::path::{Path, PathBuf};
use std::process::{Command as Process, ExitCode, Stdio};
use std::time::{Duration, Instant};

use clap::{Args, Parser, Subcommand};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

/// How long `--wait` holds on for a run, and how often it looks.
const WAIT_LIMIT: Duration = Duration::from_secs(60 * 60);
const WAIT_POLL: Duration = Duration::from_millis(200);
const REPAIR_HINT_BYTES: u64 = 1024 * 1024 * 1024;
/// How long a started service gets to say it is ready.
const START_LIMIT: Duration = Duration::from_secs(20);
/// Set to `-`, this prints what would have opened. Anything else is the program to use.
const OPENER_VARIABLE: &str = "ORBYN_OPENER";

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
    /// With no command, start the service and open it, on this folder if named.
    path: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the service in the background if it is not running, and open it.
    Start {
        /// A folder to open, registered first if it is new. It starts untrusted.
        path: Option<PathBuf>,
        /// Start, and leave the browser alone.
        #[arg(long)]
        no_open: bool,
    },
    /// Open the desktop app, on a folder if named.
    App { path: Option<PathBuf> },
    /// Run the service from this user's login, with no terminal.
    #[command(subcommand)]
    Service(ServiceCommand),
    /// Manage Orbyn's headless browser on this host.
    #[command(subcommand)]
    Browser(BrowserCommand),
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
    /// Inspect the local server trace file.
    #[command(subcommand)]
    Trace(TraceCommand),
}

#[derive(Subcommand)]
enum TraceCommand {
    /// Summarize local operation counts, rates and latency.
    Summary {
        /// Count spans that ended in this window, such as 30m or 2h.
        #[arg(long, value_parser = cli_trace::duration)]
        since: Option<Duration>,
        /// Number of span names, busiest first.
        #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u32).range(1..))]
        limit: u32,
    },
}

#[derive(Subcommand)]
enum BrowserCommand {
    /// Set up this host for Orbyn's browser.
    Setup,
}

#[derive(Subcommand)]
enum ServiceCommand {
    /// Install and start it. Run again to repair one.
    Install {
        /// Show what would change and change nothing.
        #[arg(long)]
        dry_run: bool,
    },
    /// Stop it and remove it from login. Threads and settings stay.
    Uninstall {
        #[arg(long)]
        dry_run: bool,
    },
    Restart,
    /// What this OS's service manager says.
    Status,
    /// What the service manager starts: `orbynd`, with `service.env` applied.
    #[command(hide = true)]
    Run,
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
    api_error: Option<Value>,
}

impl Failure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 1,
            api_error: None,
        }
    }

    /// A separate code, so a script can tell "nothing is running" from "it refused".
    fn not_running(detail: &str) -> Self {
        Self {
            message: format!("No Orbyn service is running{detail}. Start one with `orbyn serve`."),
            code: 2,
            api_error: None,
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
        let mut failure = Failure::new(match (status, message) {
            (_, Some(message)) => message.to_owned(),
            (StatusCode::UNAUTHORIZED, None) => "The service refused this command.".to_owned(),
            (status, None) => format!("The service answered {status}."),
        });
        failure.api_error = Some(value);
        Err(failure)
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
fn orbynd_path() -> Outcome<PathBuf> {
    let name = if cfg!(windows) {
        "orbynd.exe"
    } else {
        "orbynd"
    };
    std::env::current_exe()
        .ok()
        .and_then(|program| program.parent().map(|folder| folder.join(name)))
        .filter(|path| path.is_file())
        .ok_or_else(|| Failure::new("orbynd was not found beside this program."))
}

fn wait_for(mut command: Process) -> Outcome<()> {
    let status = command
        .status()
        .map_err(|error| Failure::new(format!("orbynd did not start: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(Failure::new("The service stopped with an error."))
    }
}

fn run_service(args: &[String], data: Option<&Path>) -> Outcome<()> {
    let mut command = service_process(args)?;
    if let Some(data) = data {
        command.arg("--data-dir").arg(data);
    }
    wait_for(command)
}

/// The sidecars share the desktop bundle's resources. Explicit serve flags win.
fn service_process(args: &[String]) -> Outcome<Process> {
    let program = orbynd_path()?;
    let mut command = Process::new(&program);
    command.arg("serve");
    if let Some(folder) = program.parent() {
        let roots = [folder.join("../Resources"), folder.to_path_buf()];
        if let Some(root) = roots
            .iter()
            .find(|root| root.join("ui/index.html").is_file())
        {
            let supplied = |flag: &str| {
                args.iter()
                    .any(|arg| arg == flag || arg.starts_with(&format!("{flag}=")))
            };
            if !supplied("--ui-dir") {
                command.arg("--ui-dir").arg(root.join("ui"));
            }
            if root.join("library/library.tar").is_file()
                && !supplied("--library-bundle")
                && std::env::var_os("ORBYN_LIBRARY_BUNDLE").is_none()
            {
                command.arg("--library-bundle").arg(root.join("library"));
            }
        }
    }
    command.args(args);
    Ok(command)
}

/// Reaches a service that answers, since `service.json` can outlive a crash.
async fn live_service(data: &Path) -> Option<Service> {
    let service = Service::find(data).ok()?;
    service.call(Method::GET, "/api/info", None).await.ok()?;
    Some(service)
}

/// Leaves a service running after this process ends, its output in the data folder.
fn start_detached(data: &Path) -> Outcome<()> {
    std::fs::create_dir_all(data)
        .map_err(|error| Failure::new(format!("{}: {error}", data.display())))?;
    let log = std::fs::File::create(data.join("service.log"))
        .map_err(|error| Failure::new(format!("The service log: {error}")))?;
    let mut command = service_process(&[])?;
    command
        .arg("--data-dir")
        .arg(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
        .spawn()
        .map_err(|error| Failure::new(format!("orbynd did not start: {error}")))?;
    Ok(())
}

async fn ensure_service(data: &Path) -> Outcome<(Service, bool)> {
    if let Some(service) = live_service(data).await {
        return Ok((service, false));
    }
    start_detached(data)?;
    let started = Instant::now();
    while started.elapsed() < START_LIMIT {
        if let Some(service) = live_service(data).await {
            return Ok((service, true));
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
    Err(Failure::new(format!(
        "The service did not start. See {}.",
        data.join("service.log").display()
    )))
}

/// The project for a folder: the one registered there, or a new one.
async fn project_for(service: &Service, path: &Path) -> Outcome<String> {
    let real = std::fs::canonicalize(path)
        .map_err(|_| Failure::new(format!("{} does not exist.", path.display())))?;
    let projects = service.call(Method::GET, "/api/projects", None).await?;
    let known = projects.as_array().into_iter().flatten().find(|project| {
        project["path"]
            .as_str()
            .and_then(|known| std::fs::canonicalize(known).ok())
            .is_some_and(|known| known == real)
    });
    let project = match known {
        Some(project) => project.clone(),
        None => {
            let body = json!({ "path": real });
            service
                .call(Method::POST, "/api/projects/add", Some(body))
                .await
                .or_else(|failure| {
                    if let Some(error) = &failure.api_error
                        && error["code"] == "project_exists"
                        && error["detail"]["id"].is_string()
                    {
                        return Ok(error["detail"].clone());
                    }
                    Err(failure)
                })?
        }
    };
    project["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Failure::new("The service did not name that project."))
}

fn open(target: &str) -> Outcome<()> {
    let opener = std::env::var(OPENER_VARIABLE).ok();
    let mut command = match opener.as_deref() {
        Some("-") => {
            println!("{target}");
            return Ok(());
        }
        Some(program) => Process::new(program),
        None if cfg!(target_os = "macos") => Process::new("open"),
        None if cfg!(windows) => {
            let mut start = Process::new("cmd");
            start.args(["/C", "start", ""]);
            start
        }
        None => Process::new("xdg-open"),
    };
    command
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(Failure::new(
            "Nothing here could open that. The service is still running.",
        )),
    }
}

async fn start(cli: &Cli, path: Option<&Path>, no_open: bool) -> Outcome<()> {
    let data = data_dir(cli)?;
    let (service, started) = ensure_service(&data).await?;
    let project = match path {
        Some(path) => Some(project_for(&service, path).await?),
        None => None,
    };
    if !no_open {
        let route = project
            .as_deref()
            .map_or_else(|| "#/".to_owned(), |id| format!("#/new/{id}"));
        open(&format!("{}/?token={}{route}", service.url, service.token))?;
    }
    if cli.json {
        let report = json!({ "url": service.url, "started": started, "project": project });
        println!("{report}");
    } else if started {
        println!("Started at {}", service.url);
    } else {
        println!("Already running at {}", service.url);
    }
    Ok(())
}

async fn open_app(cli: &Cli, path: Option<&Path>) -> Outcome<()> {
    let Some(path) = path else {
        return open("orbyn://");
    };
    let service = Service::find(&data_dir(cli)?)?;
    let project = project_for(&service, path).await?;
    open(&format!("orbyn://new/{project}"))
}

fn home_dir() -> Outcome<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| Failure::new("No home folder was found."))
}

#[cfg(unix)]
fn user_id(home: &Path) -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(home).map_or(0, |meta| meta.uid())
}

#[cfg(not(unix))]
fn user_id(_home: &Path) -> u32 {
    0
}

fn run_step(step: &cli_service::Step) -> Outcome<std::process::Output> {
    let output = Process::new(&step.program)
        .args(&step.args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| Failure::new(format!("{}: {error}", step.program)))?;
    if output.status.success() || step.may_fail {
        return Ok(output);
    }
    Err(Failure::new(format!(
        "{} failed: {}",
        step.program,
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

fn show_plan(plan: &cli_service::Plan, json_output: bool) {
    if json_output {
        let steps: Vec<Value> = plan
            .steps
            .iter()
            .map(|step| json!({ "program": step.program, "args": step.args }))
            .collect();
        let report = json!({
            "file": plan.file.as_ref().map(|(path, _)| path),
            "text": plan.file.as_ref().map(|(_, text)| text),
            "remove": plan.remove,
            "steps": steps,
        });
        println!("{report}");
        return;
    }
    if let Some((path, text)) = &plan.file {
        println!("Would write {}:\n{text}", path.display());
    }
    if let Some(path) = &plan.remove {
        println!("Would remove {}", path.display());
    }
    for step in &plan.steps {
        println!("Would run {} {}", step.program, step.args.join(" "));
    }
}

fn apply_plan(plan: &cli_service::Plan) -> Outcome<()> {
    if let Some((path, text)) = &plan.file {
        let failed = |error: std::io::Error| Failure::new(format!("{}: {error}", path.display()));
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder).map_err(failed)?;
        }
        std::fs::write(path, text).map_err(failed)?;
    }
    for step in &plan.steps {
        run_step(step)?;
    }
    if let Some(path) = &plan.remove {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(Failure::new(format!("{}: {error}", path.display())));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Starts `orbynd` with `service.env` in its environment and stays with it, so the
/// service manager watches the real process.
fn run_as_service(data: &Path) -> Outcome<()> {
    let values = match std::fs::read_to_string(data.join("service.env")) {
        Ok(text) => cli_service::parse_env(&text)
            .map_err(|error| Failure::new(format!("service.env: {error}")))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::collections::BTreeMap::new()
        }
        Err(error) => {
            return Err(Failure::new(format!(
                "service.env could not be read: {error}"
            )));
        }
    };
    let values = values
        .into_iter()
        .filter(|(name, _)| !cli_service::managed_env_name(name))
        .collect::<std::collections::BTreeMap<_, _>>();
    let args = values
        .get("ORBYN_LIBRARY_BUNDLE")
        .map_or_else(Vec::new, |path| {
            vec!["--library-bundle".to_owned(), path.clone()]
        });
    let mut command = service_process(&args)?;
    command.arg("--data-dir").arg(data).envs(values);
    wait_for(command)
}

fn service_command(cli: &Cli, command: &ServiceCommand) -> Outcome<()> {
    let data = data_dir(cli)?;
    if matches!(command, ServiceCommand::Run) {
        return run_as_service(&data);
    }
    let os = cli_service::Os::current().map_err(Failure::new)?;
    let home = home_dir()?;
    let program = std::env::current_exe()
        .map_err(|error| Failure::new(format!("This program's path: {error}")))?;
    let install = cli_service::Install {
        os,
        home: &home,
        program: &program,
        data: &data,
        uid: user_id(&home),
    };
    let chosen = |plan: cli_service::Plan, dry_run: bool| {
        if dry_run {
            show_plan(&plan, cli.json);
            Ok(())
        } else {
            apply_plan(&plan)
        }
    };
    match command {
        ServiceCommand::Install { dry_run } => chosen(install.install(), *dry_run),
        ServiceCommand::Uninstall { dry_run } => chosen(install.uninstall(), *dry_run),
        ServiceCommand::Restart => chosen(install.restart(), false),
        ServiceCommand::Status => {
            let mut step = install.status();
            step.may_fail = true;
            let output = run_step(&step)?;
            print!("{}", String::from_utf8_lossy(&output.stdout));
            if output.status.success() {
                Ok(())
            } else {
                Err(Failure::new("The service is not installed."))
            }
        }
        ServiceCommand::Run => Ok(()),
    }
}

async fn run(cli: Cli) -> Outcome<()> {
    let Some(command) = &cli.command else {
        let path = cli.path.as_deref();
        if path.is_some_and(|path| !path.is_dir()) {
            return Err(Failure::new(format!(
                "{} is neither a command nor a folder. See `orbyn help`.",
                path.unwrap_or(Path::new("")).display()
            )));
        }
        return start(&cli, path, false).await;
    };
    match command {
        Command::Trace(TraceCommand::Summary { since, limit }) => {
            return cli_trace::summary(&data_dir(&cli)?, *since, *limit, cli.json)
                .map_err(Failure::new);
        }
        Command::Start { path, no_open } => return start(&cli, path.as_deref(), *no_open).await,
        Command::App { path } => return open_app(&cli, path.as_deref()).await,
        Command::Service(service) => return service_command(&cli, service),
        Command::Browser(BrowserCommand::Setup) => {
            if !cfg!(any(target_os = "macos", windows)) {
                return Err(Failure::new(
                    "Browser setup is not supported on this platform.",
                ));
            }
            println!("Nothing to set up: Orbyn's browser runs as is on this system.");
            return Ok(());
        }
        Command::Serve { args } => return run_service(args, cli.data_dir.as_deref()),
        Command::Status => return status(&cli).await,
        Command::Doctor { fix, .. } => return doctor(&cli, *fix).await,
        _ => {}
    }
    let service = Service::find(&data_dir(&cli)?)?;
    let json_output = cli.json;
    match cli.command {
        Some(Command::Thread(command)) => thread_command(&service, command, json_output).await,
        Some(Command::Project(command)) => project_command(&service, command, json_output).await,
        Some(Command::Theme(command)) => theme_command(&service, command, json_output).await,
        _ => Ok(()),
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
