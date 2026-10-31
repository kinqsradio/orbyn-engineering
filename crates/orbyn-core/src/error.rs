//! Expected failures and their stable client codes. Transport maps `status` and
//! `code` directly to `ApiError`, so a client can branch without parsing prose.

use orbyn_contracts::Approval;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0} not found")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("this thread already has an active run")]
    ThreadBusy,
    #[error("trust this folder before starting an engine in it")]
    FolderUntrusted,
    #[error("this approval was already decided")]
    AlreadyDecided(Box<Approval>),
    #[error("{0} has an active run or update")]
    EngineBusy(String),
    #[error("{0}")]
    EngineUnavailable(String),
    #[error("this thread is archived")]
    ThreadArchived,
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    UpdateUnavailable(String),
    #[error("{0}")]
    UpdateFailed(String),
    #[error("{0}")]
    PolicyDenied(String),
    /// A write from a process that no longer owns the run.
    #[error("run is owned by another process")]
    StaleOwner,
    /// A write against a run that already reached a terminal state.
    #[error("run has ended")]
    RunClosed,
    #[error("run cannot move from {from} to {to}")]
    InvalidTransition { from: String, to: String },
    #[error("database schema {found} is newer than supported schema {supported}")]
    DatabaseTooNew { found: i64, supported: i64 },
    #[error("another orbynd owns this data directory")]
    DataDirLocked,
    #[error("skill pack failed verification: {0}")]
    PackTampered(String),
    #[error("{0}")]
    Computer(String),
    #[error("{0}")]
    Git(String),
    #[error("storage error: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("encoding error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Internal(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::Invalid(_) => "invalid_input",
            Self::ThreadBusy => "thread_busy",
            Self::FolderUntrusted => "folder_untrusted",
            Self::AlreadyDecided(_) => "already_decided",
            Self::EngineBusy(_) => "engine_busy",
            Self::EngineUnavailable(_) => "engine_unavailable",
            Self::ThreadArchived => "thread_archived",
            Self::Unsupported(_) => "unsupported",
            Self::UpdateUnavailable(_) => "update_unavailable",
            Self::UpdateFailed(_) => "update_failed",
            Self::PolicyDenied(_) => "policy_denied",
            Self::StaleOwner => "stale_owner",
            Self::RunClosed => "run_closed",
            Self::InvalidTransition { .. } => "invalid_transition",
            Self::DatabaseTooNew { .. } => "database_too_new",
            Self::DataDirLocked => "data_dir_locked",
            Self::PackTampered(_) => "pack_tampered",
            Self::Computer(_) => "computer_failed",
            Self::Git(_) => "git_failed",
            Self::Store(_) | Self::Io(_) | Self::Json(_) | Self::Internal(_) => "internal",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::NotFound(_) => 404,
            Self::Invalid(_) => 400,
            Self::FolderUntrusted | Self::PolicyDenied(_) => 403,
            Self::ThreadBusy
            | Self::AlreadyDecided(_)
            | Self::ThreadArchived
            | Self::EngineBusy(_)
            | Self::StaleOwner
            | Self::RunClosed
            | Self::InvalidTransition { .. } => 409,
            Self::UpdateUnavailable(_) | Self::Unsupported(_) => 422,
            Self::EngineUnavailable(_) | Self::Computer(_) | Self::UpdateFailed(_) => 502,
            _ => 500,
        }
    }

    /// Message safe to show a client. Storage and I/O detail stays in the log.
    pub fn public_message(&self) -> String {
        match self {
            Self::Store(_) | Self::Io(_) | Self::Json(_) | Self::Internal(_) => {
                "Orbyn hit an internal error. Check the service log.".to_owned()
            }
            other => other.to_string(),
        }
    }
}

pub type Result<T, E = CoreError> = std::result::Result<T, E>;
