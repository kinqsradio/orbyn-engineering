//! Orbyn product behavior: store, run lifecycle, policy, audit, skills, engines,
//! git, terminal and computer gateway. Transport lives in `orbynd`.

pub mod acp_registry;
pub mod app;
pub mod approvals;
pub mod automations;
pub mod checkpoints;
pub mod child_env;
pub mod composer;
pub mod computer;
pub mod diagnostics;
pub mod driver;
pub mod engines;
pub mod error;
pub mod file_bytes;
pub mod file_changes;
pub mod files;
pub mod forge;
pub mod git;
pub mod keybindings;
pub mod local_trace;
pub mod maintenance;
pub mod mcp;
pub mod mcp_tools;
pub mod network;
pub mod policy;
pub mod preferences;
pub mod preview;
pub mod process;
pub mod project_file;
pub mod project_icons;
pub mod project_scopes;
mod project_setup;
pub mod projects;
pub mod questions;
pub mod runs;
pub mod scm;
pub mod scratch;
pub mod search;
pub mod selection;
pub mod shell;
pub mod skills;
pub mod sse;
pub mod store;
pub mod terminal;
pub mod threads;
pub mod titles;
pub mod updates;
pub mod usage;
pub mod util;
pub mod workspace;

#[cfg(test)]
mod testing;

pub use app::{Core, CoreConfig};
pub use error::{CoreError, Result};
