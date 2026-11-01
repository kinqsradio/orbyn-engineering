//! What `orbyn service` asks the OS to do, as data, so it can be read before it
//! happens and tested without touching the machine's real service manager. The user's
//! own manager runs it: launchd on macOS or systemd on Linux.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LABEL: &str = "com.orbyn.engineering";
const UNIT: &str = "orbyn-engineering.service";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Result<Self, &'static str> {
        Self::for_platform(std::env::consts::OS)
    }

    fn for_platform(platform: &str) -> Result<Self, &'static str> {
        match platform {
            "macos" => Ok(Self::Mac),
            "linux" => Ok(Self::Linux),
            _ => Err("Background setup supports Linux with systemd and macOS with launchd."),
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
        }
    }

    pub fn restart(&self) -> Plan {
        let steps = match self.os {
            Os::Mac => vec![step("launchctl", &["kickstart", "-k", &self.target()])],
            Os::Linux => vec![step("systemctl", &["--user", "restart", UNIT])],
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
        }
    }
}

/// Dotenv-style values, with no shell evaluation or variable expansion. Invalid
/// assignments still stop startup with a line number rather than silently vanish.
pub fn parse_env(text: &str) -> Result<BTreeMap<String, String>, String> {
    let text = text.replace("\r\n", "\n");
    let mut values = BTreeMap::new();
    let (mut cursor, mut number) = (0, 1);
    while cursor < text.len() {
        let line_end = text[cursor..].find('\n').map_or(text.len(), |n| cursor + n);
        let line = text[cursor..line_end].trim();
        if line.is_empty()
            || line.starts_with('#')
            || (line.starts_with('\u{feff}') && !line.contains('='))
        {
            cursor = (line_end + 1).min(text.len());
            number += 1;
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .or_else(|| line.strip_prefix("export\t"))
            .unwrap_or(line)
            .trim_start();
        let (name, _) = line
            .split_once('=')
            .ok_or_else(|| format!("Line {number} has no `=`."))?;
        let name = name.trim();
        // The reference validates parsed keys as ASCII identifiers. A UTF-8
        // BOM remains part of its key, so that entry is discarded, not renamed.
        let discard_key = name.starts_with('\u{feff}');
        if !discard_key
            && (name.is_empty()
                || name.starts_with(|c: char| c.is_ascii_digit())
                || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        {
            return Err(format!(
                "Line {number} does not start with a variable name."
            ));
        }
        let equals = text[cursor..line_end]
            .find('=')
            .expect("assignment has equals");
        let start = cursor + equals + 1;
        let value_text = text[start..].trim_start_matches([' ', '\t']);
        let value_start = text.len() - value_text.len();
        let (value, end) = if let Some(quote) = value_text
            .chars()
            .next()
            .filter(|c| matches!(c, '\'' | '"' | '`'))
        {
            let close = value_text[1..]
                .find(quote)
                .ok_or_else(|| format!("Line {number} has an unterminated quoted value."))?
                + 1;
            let value = &value_text[1..close];
            let value = if quote == '"' {
                value.replace("\\n", "\n")
            } else {
                value.to_owned()
            };
            let after = value_start + close + 1;
            let end = text[after..].find('\n').map_or(text.len(), |n| after + n);
            (value, end)
        } else {
            let raw = &text[start..line_end];
            (
                raw.split('#').next().unwrap_or_default().trim().to_owned(),
                line_end,
            )
        };
        if value.contains('\0') {
            return Err(format!("Line {number} contains a null character."));
        }
        if !discard_key {
            values.insert(name.to_owned(), value);
        }
        number += text[cursor..end]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1;
        cursor = (end + 1).min(text.len());
    }
    Ok(values)
}

/// These belong to the launching process, not to a service.env override. Names
/// are compared without case because Windows environment names ignore case.
/// ORBYN_DATA_DIR is the application-home control (T3CODE_HOME's counterpart).
/// Manager names are compile-time constants and the launcher waits for its child
/// directly, so neither manager identity nor launcher context has an env control.
pub fn managed_env_name(name: &str) -> bool {
    ["PATH", "ORBYN_DATA_DIR"]
        .iter()
        .any(|managed| name.eq_ignore_ascii_case(managed))
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
            ["bootstrap", "gui/501", path.to_string_lossy().as_ref()]
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
    fn windows_has_no_background_service_manager() {
        assert_eq!(Os::for_platform("macos"), Ok(Os::Mac));
        assert_eq!(Os::for_platform("linux"), Ok(Os::Linux));
        assert!(Os::for_platform("windows").is_err());
    }

    #[test]
    fn uninstall_tolerates_a_service_already_gone() {
        for os in [Os::Mac, Os::Linux] {
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
        let values = parse_env("# a note\nexport A=1 # ignored\nB=\"two words # x=y $HOME ${USER} $(whoami)\" # ignored\r\nC=x=y\nD=\nMULTI='first\nsecond'\n").unwrap();
        assert_eq!(values["A"], "1");
        assert_eq!(values["B"], "two words # x=y $HOME ${USER} $(whoami)");
        assert_eq!(values["C"], "x=y");
        assert_eq!(values["D"], "");
        assert_eq!(values["MULTI"], "first\nsecond");
    }

    #[test]
    fn dotenv_quote_and_bom_edges_match_the_reference_runtime() {
        let values = parse_env(concat!(
            r#"A="first\"second""#,
            "\n",
            r#"B="one\ntwo\rthree""#,
            "\n\u{feff}IGNORED='first\nsecond'\n\u{feff}# heading\nC=kept\n"
        ))
        .unwrap();
        assert_eq!(values["A"], r#"first\"#);
        assert_eq!(values["B"], concat!("one\n", r#"two\rthree"#));
        assert!(!values.contains_key("IGNORED"));
        assert_eq!(values["C"], "kept");
    }

    #[test]
    fn launcher_managed_names_map_to_the_actual_orbyn_controls() {
        for name in ["PATH", "Path", "pAtH", "ORBYN_DATA_DIR", "orbyn_data_dir"] {
            assert!(managed_env_name(name), "{name}");
        }
        // T3 protects its application home, not the system user's HOME.
        assert!(!managed_env_name("HOME"));
        assert!(!managed_env_name("USERPROFILE"));
        assert!(!managed_env_name("ORBYN_WORKSPACE_URL"));
    }

    #[test]
    fn a_line_that_is_not_a_variable_is_refused_by_number() {
        assert_eq!(parse_env("A=1\noops\n").unwrap_err(), "Line 2 has no `=`.");
        assert!(parse_env("1A=x").is_err());
        assert!(parse_env("A B=x").is_err());
        assert!(parse_env("=x").is_err());
        assert!(parse_env("A=\0").is_err());
        assert_eq!(
            parse_env("A='first\nsecond'\nbad").unwrap_err(),
            "Line 3 has no `=`."
        );
        assert!(parse_env("A='unfinished").is_err());
    }
}
