//! Steward core: local classifier, send gate, mock backends, cache, SQLite history.
//!
//! Classify is a free heuristic (zero tokens, zero dollars) and must never
//! increment `MockBackends.call_count`.

pub mod backends;
pub mod cache;
pub mod classify;
pub mod history;
pub mod keys;
pub mod payload;
pub mod pricing;
pub mod send;
pub mod types;

pub use backends::{BackendError, MockBackends};
pub use cache::PromptCache;
pub use classify::classify;
pub use history::{record_send, RunHistory, RunRecord};
pub use payload::{build_brief, contains_repo_path, strip_repo_paths};
pub use pricing::{estimate_cost, estimate_tokens};
pub use send::send;
pub use types::{
    BlockReason, BudgetSnapshot, ClassifyRequest, ClassifyResult, FanOut, Owner, SendError,
    SendOutcome,
};

/// Default daily spend cap (USD). Monthly placeholder is 20× this in the UI.
pub const DEFAULT_DAILY_CAP_USD: f64 = 5.0;
pub const DEFAULT_PER_RUN_CAP_USD: f64 = 1.0;
pub const MONTHLY_CAP_MULTIPLIER: f64 = 20.0;
