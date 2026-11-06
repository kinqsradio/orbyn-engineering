//! Orbyn product behavior: store, run lifecycle, policy, audit, skills, engines,
//! git, terminal and computer gateway. Transport lives in `orbynd`.

pub mod agents;
pub mod app;
pub mod browser;
pub mod conversation;
pub mod error;
pub mod governance;
pub mod host;
pub mod operations;
pub mod project;
pub mod settings;
pub mod source_control;
pub mod store;
pub mod tools;
pub mod util;

#[cfg(test)]
mod testing;

pub use app::{Core, CoreConfig};
pub use error::{CoreError, Result};
