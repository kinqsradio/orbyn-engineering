//! Orbyn product behavior: store, run lifecycle, policy, audit, skills, engines,
//! git, terminal and computer gateway. Transport lives in `orbynd`.

pub mod app;
pub mod approvals;
pub mod checkpoints;
pub mod composer;
pub mod computer;
pub mod driver;
pub mod engines;
pub mod error;
pub mod files;
pub mod git;
pub mod mcp;
pub mod policy;
pub mod process;
pub mod projects;
pub mod runs;
pub mod scm;
pub mod skills;
pub mod sse;
pub mod store;
pub mod terminal;
pub mod threads;
pub mod updates;
pub mod util;
pub mod workspace;

#[cfg(test)]
mod testing;

pub use app::{Core, CoreConfig};
pub use error::{CoreError, Result};
