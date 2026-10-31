//! Orbyn product behavior: store, run lifecycle, policy, audit, skills, engines,
//! git, terminal and computer gateway. Transport lives in `orbynd`.

pub mod error;
pub mod store;
pub mod util;

#[cfg(test)]
mod testing;

pub use error::{CoreError, Result};
