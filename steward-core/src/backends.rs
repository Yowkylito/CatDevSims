//! Mock backends. Classify NEVER goes through here.
//! `call_count` is the paid-send counter. There is no classify_call_count.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendError {
    /// HTTP 429 from a free-tier mock.
    RateLimited,
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendError::RateLimited => write!(f, "HTTP 429"),
        }
    }
}

impl std::error::Error for BackendError {}

#[derive(Debug, Default)]
pub struct MockBackends {
    /// Incremented once per actual mock HTTP call (including a 429).
    pub call_count: u32,
    /// When true, the *next* paid call returns 429.
    pub inject_429: bool,
    /// After a 429, further calls degrade without incrementing (no retry-storm).
    hit_429: bool,
}

impl MockBackends {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn call_count(&self) -> u32 {
        self.call_count
    }

    pub fn chatgpt(&mut self, brief: &str) -> Result<String, BackendError> {
        self.call("chatgpt", brief)
    }

    pub fn claude(&mut self, brief: &str) -> Result<String, BackendError> {
        self.call("claude", brief)
    }

    pub fn cursor(&mut self, brief: &str) -> Result<String, BackendError> {
        self.call("cursor", brief)
    }

    fn call(&mut self, name: &str, brief: &str) -> Result<String, BackendError> {
        // Retry after 429: do not bump the counter a second time; caller degrades.
        if self.hit_429 {
            return Err(BackendError::RateLimited);
        }
        if self.inject_429 {
            self.call_count = self.call_count.saturating_add(1);
            self.hit_429 = true;
            return Err(BackendError::RateLimited);
        }
        self.call_count = self.call_count.saturating_add(1);
        Ok(format!("[{name} mock] {brief}"))
    }
}
