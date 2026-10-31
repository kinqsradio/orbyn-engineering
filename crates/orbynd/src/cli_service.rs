//! What `orbyn service` asks the OS to do, as data, so it can be read before it
//! happens and tested without touching the machine's real service manager. The user's
//! own manager runs it: launchd on macOS, Task Scheduler on Windows, systemd on Linux.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LABEL: &str = "com.orbyn.engineering";
const UNIT: &str = "orbyn-engineering.service";
const TASK: &str = "OrbynEngineering";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

/// One step. A step allowed to fail is one that clears what may not be there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub program: String,
    pub args: Vec<String>,
    pub may_fail: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// The file the manager reads, and what goes in it.
    pub file: Option<(PathBuf, String)>,
    /// A file to delete.
    pub remove: Option<PathBuf>,
    pub steps: Vec<Step>,
}

/// Where a service runs from.
pub struct Install<'a> {
    pub os: Os,
    pub home: &'a Path,
    /// This `orbyn`, which reads `service.env` and starts `orbynd`.
    pub program: &'a Path,
    pub data: &'a Path,
    /// launchd addresses a user by number.
    pub uid: u32,
}

fn step(program: &str, args: &[&str]) -> Step {
    Step {
        program: program.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        may_fail: false,
    }
}

fn clearing(mut step: Step) -> Step {
    step.may_fail = true;
    step
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

impl Install<'_> {
    fn arguments(&self) -> Vec<String> {
        vec![
            self.program.to_string_lossy().into_owned(),
            "--data-dir".to_owned(),
            self.data.to_string_lossy().into_owned(),
            "service".to_owned(),
            "run".to_owned(),
        ]
    }

    fn manager_file(&self) -> PathBuf {
        match self.os {
            Os::Mac => self
                .home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
            Os::Linux => self.home.join(".config/systemd/user").join(UNIT),
            Os::Windows => PathBuf::new(),
        }
    }

    fn domain(&self) -> String {
        format!("gui/{}", self.uid)
    }

    fn target(&self) -> String {
        format!("{}/{LABEL}", self.domain())
    }

    fn plist(&self) -> String {
        let arguments: String = self
            .arguments()
            .iter()
            .map(|arg| format!("    <string>{}</string>\n", xml(arg)))
            .collect();
        let log = xml(&self.data.join("service.log").to_string_lossy());
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n<dict>\n\
             \x20 <key>Label</key><string>{LABEL}</string>\n\
             \x20 <key>ProgramArguments</key>\n  <array>\n{arguments}  </array>\n\
             \x20 <key>RunAtLoad</key><true/>\n\
             \x20 <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n\
             \x20 <key>StandardErrorPath</key><string>{log}</string>\n\
             \x20 <key>StandardOutPath</key><string>{log}</string>\n\
             </dict>\n</plist>\n"
        )
    }

    fn unit(&self) -> String {
        let quoted: Vec<String> = self
            .arguments()
            .iter()
            .map(|arg| {
                let escaped = arg
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%");
                format!("\"{escaped}\"")
            })
            .collect();
        format!(
            "[Unit]\nDescription=Orbyn Engineering\n\n[Service]\nExecStart={}\n\
             Restart=on-failure\n\n[Install]\nWantedBy=default.target\n",
            quoted.join(" ")
        )
    }

    /// `/TR` takes one string, so each part is quoted inside it.
    fn task_command(&self) -> String {
        self.arguments()
            .iter()
            .map(|arg| format!("\"{arg}\""))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Doing this again repairs an install, so each one clears what is there first.
    pub fn install(&self) -> Plan {
        let file = self.manager_file();
        let text = file.to_string_lossy().into_owned();
        match self.os {
            Os::Mac => Plan {
                file: Some((file, self.plist())),
                remove: None,
                steps: vec![
                    clearing(step("launchctl", &["bootout", &self.target()])),
                    step("launchctl", &["bootstrap", &self.domain(), &text]),
                ],
            },
            Os::Linux => Plan {
                file: Some((file, self.unit())),
                remove: None,
                steps: vec![
                    step("systemctl", &["--user", "daemon-reload"]),
                    step("systemctl", &["--user", "enable", "--now", UNIT]),
                ],
            },
            Os::Windows => Plan {
                file: None,
                remove: None,
                steps: vec![
                    step(
                        "schtasks",
                        &[
                            "/Create",
                            "/F",
                            "/SC",
                            "ONLOGON",
                            "/TN",
                            TASK,
                            "/TR",
                            &self.task_command(),
                        ],
                    ),
                    step("schtasks", &["/Run", "/TN", TASK]),
                ],
            },
        }
    }

    pub fn uninstall(&self) -> Plan {
        let file = self.manager_file();
        match self.os {
            Os::Mac => Plan {
                file: None,
                remove: Some(file),
                steps: vec![clearing(step("launchctl", &["bootout", &self.target()]))],
            },
            Os::Linux => Plan {
                file: None,
                remove: Some(file),
                steps: vec![clearing(step(
                    "systemctl",
                    &["--user", "disable", "--now", UNIT],
                ))],
            },
            Os::Windows => Plan {
                file: None,
                remove: None,
                steps: vec![
                    clearing(step("schtasks", &["/End", "/TN", TASK])),
                    clearing(step("schtasks", &["/Delete", "/F", "/TN", TASK])),
                ],
            },
        }
    }

    pub fn restart(&self) -> Plan {
        let steps = match self.os {
            Os::Mac => vec![step("launchctl", &["kickstart", "-k", &self.target()])],
            Os::Linux => vec![step("systemctl", &["--user", "restart", UNIT])],
            Os::Windows => vec![
                clearing(step("schtasks", &["/End", "/TN", TASK])),
                step("schtasks", &["/Run", "/TN", TASK]),
            ],
        };
        Plan {
            steps,
            ..Plan::default()
        }
    }

    pub fn status(&self) -> Step {
        match self.os {
            Os::Mac => step("launchctl", &["print", &self.target()]),
            Os::Linux => step("systemctl", &["--user", "status", "--no-pager", UNIT]),
            Os::Windows => step("schtasks", &["/Query", "/TN", TASK]),
        }
    }
}

/// `service.env`: one `NAME=value` a line, taken literally, because a person's secret
/// can hold any character. Comments and blank lines are skipped. Orbyn reads nothing
/// from it: it only goes into the service's own environment.
pub fn parse_env(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let number = index + 1;
        let (name, value) = line
            .split_once('=')
            .ok_or_else(|| format!("Line {number} has no `=`."))?;
        let usable = !name.is_empty()
            && !name.starts_with(|c: char| c.is_ascii_digit())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !usable {
            return Err(format!(
                "Line {number} does not start with a variable name."
            ));
        }
        values.insert(name.to_owned(), value.to_owned());
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(os: Os) -> Plan {
        Install {
            os,
            home: Path::new("/home/a"),
            program: Path::new("/bin/a & b/orbyn"),
            data: Path::new("/data/100%"),
            uid: 501,
        }
        .install()
    }

    #[test]
    fn launchd_gets_a_well_formed_agent_for_this_user() {
        let plan = install(Os::Mac);
        let (path, text) = plan.file.unwrap();
        assert_eq!(
            path,
            Path::new("/home/a/Library/LaunchAgents/com.orbyn.engineering.plist")
        );
        assert!(text.contains("<string>/bin/a &amp; b/orbyn</string>"));
        assert!(text.contains("<string>service</string>\n    <string>run</string>"));
        assert_eq!(
            plan.steps[1].args,
            [
                "bootstrap",
                "gui/501",
                "/home/a/Library/LaunchAgents/com.orbyn.engineering.plist"
            ]
        );
        assert!(plan.steps[0].may_fail, "nothing may be loaded yet");
    }

    #[test]
    fn systemd_quotes_the_path_and_escapes_its_specifier() {
        let plan = install(Os::Linux);
        let (path, text) = plan.file.unwrap();
        assert!(path.ends_with(".config/systemd/user/orbyn-engineering.service"));
        assert!(text.contains(r#"ExecStart="/bin/a & b/orbyn" "--data-dir" "/data/100%%""#));
    }

    #[test]
    fn task_scheduler_gets_one_quoted_command_and_no_file() {
        let plan = install(Os::Windows);
        assert!(plan.file.is_none());
        let create = &plan.steps[0];
        assert!(create.args.contains(&"ONLOGON".to_owned()));
        assert!(
            create
                .args
                .last()
                .unwrap()
                .starts_with(r#""/bin/a & b/orbyn" "--data-dir""#)
        );
    }

    #[test]
    fn uninstall_tolerates_a_service_already_gone() {
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            let plan = Install {
                os,
                home: Path::new("/h"),
                program: Path::new("/p"),
                data: Path::new("/d"),
                uid: 1,
            }
            .uninstall();
            assert!(plan.steps.iter().all(|step| step.may_fail), "{os:?}");
        }
    }

    #[test]
    fn the_environment_file_is_literal() {
        let values = parse_env("# a note\n\nA=1\nB=\"two words\" # kept\r\nC=x=y\nD=\n").unwrap();
        assert_eq!(values["A"], "1");
        assert_eq!(values["B"], "\"two words\" # kept");
        assert_eq!(values["C"], "x=y");
        assert_eq!(values["D"], "");
    }

    #[test]
    fn a_line_that_is_not_a_variable_is_refused_by_number() {
        assert_eq!(parse_env("A=1\noops\n").unwrap_err(), "Line 2 has no `=`.");
        assert!(parse_env("1A=x").is_err());
        assert!(parse_env("A B=x").is_err());
        assert!(parse_env("=x").is_err());
    }
}
