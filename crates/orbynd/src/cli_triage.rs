//! Foreground terminal I/O for the native support session.

use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use orbyn_core::agents::triage::{self, Agent, Choice};

pub fn run(data: &Path, agent: Option<Agent>, model: Option<&str>) -> Result<i32, String> {
    let session = triage::prepare(data)
        .map_err(|_| "Could not write the support session files.".to_owned())?;
    let claude = Agent::Claude.resolve();
    let codex = Agent::Codex.resolve();
    let choice = triage::choose(
        agent,
        claude.is_some(),
        codex.is_some(),
        std::io::stdin().is_terminal(),
        std::io::stdout().is_terminal(),
    )?;
    let selected = match choice {
        Choice::Agent(agent) => agent,
        Choice::Pick => pick(&mut std::io::stdin().lock(), &mut std::io::stdout().lock())?,
        Choice::Manual => {
            println!(
                "No supported agent launcher was found. Paste {} into your own agent; context is in {}.",
                session.prompt.display(),
                session.context.display()
            );
            return Ok(0);
        }
    };
    let resolved = match selected {
        Agent::Claude => claude,
        Agent::Codex => codex,
    }
    .ok_or_else(|| "The selected agent is no longer available.".to_owned())?;
    println!(
        "Starting {} in its native terminal. Its permissions and login apply; this is outside Orbyn governed runs.",
        selected.name()
    );
    let mut command = Command::new(resolved.program);
    command
        .args(resolved.prefix)
        .args(triage::arguments(model))
        .current_dir(session.directory)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    orbyn_core::host::child_env::for_tool(&mut command);
    let status = command
        .status()
        .map_err(|_| format!("Could not start {}.", selected.name()))?;
    Ok(status.code().unwrap_or(1))
}

fn pick(input: &mut impl BufRead, output: &mut impl Write) -> Result<Agent, String> {
    loop {
        write!(
            output,
            "Run triage with:\n  [1] Claude Code\n  [2] Codex\n> "
        )
        .and_then(|_| output.flush())
        .map_err(|_| "Could not display the agent choice.".to_owned())?;
        let mut answer = String::new();
        if input
            .read_line(&mut answer)
            .map_err(|_| "Could not read the agent choice.".to_owned())?
            == 0
        {
            return Err("No agent selected. Use --agent claude or --agent codex.".into());
        }
        match answer.trim().to_ascii_lowercase().as_str() {
            "1" | "claude" => return Ok(Agent::Claude),
            "2" | "codex" => return Ok(Agent::Codex),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_retries_and_accepts_names_numbers_and_eof() {
        for (input, wanted) in [
            ("bad\n1\n", Agent::Claude),
            ("CoDeX\n", Agent::Codex),
            ("2\n", Agent::Codex),
            ("claude\n", Agent::Claude),
        ] {
            assert_eq!(
                pick(&mut input.as_bytes(), &mut Vec::new()).unwrap(),
                wanted
            );
        }
        assert!(pick(&mut &b"bad\n"[..], &mut Vec::new()).is_err());
    }
}
