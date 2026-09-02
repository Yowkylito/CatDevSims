//! Pricing tables used for *estimates only*. Keep them simple and documented.
//!
//! - chatgpt: ~$0.15 / 1M in, $0.60 / 1M out (cheap draft model)
//! - claude:  ~$3 / 1M in, $15 / 1M out (sonnet-class)
//! - cursor:  $0.002 per estimated 1k tokens combined (placeholder; still > 0)
//! - local:   0 only on cacheHit
//!
//! Token estimate: chars/4 plus a small out estimate. Paid owners must
//! land at cost > 0 so a send is never "guessed zero".

use crate::types::Owner;

pub const CHATGPT_IN_PER_MILLION: f64 = 0.15;
pub const CHATGPT_OUT_PER_MILLION: f64 = 0.60;
pub const CLAUDE_IN_PER_MILLION: f64 = 3.0;
pub const CLAUDE_OUT_PER_MILLION: f64 = 15.0;
/// Placeholder: $0.002 per 1k combined tokens.
pub const CURSOR_PER_1K_COMBINED: f64 = 0.002;

/// Heuristic token counts from prompt length. Empty prompt => (0, 0).
pub fn estimate_tokens(prompt: &str) -> (u32, u32) {
    let chars = prompt.chars().count();
    if chars == 0 || prompt.trim().is_empty() {
        return (0, 0);
    }
    let tin = ((chars as f64) / 4.0).ceil() as u32;
    let tin = tin.max(1);
    // Small out estimate: half of in plus a short reply floor.
    let tout = ((tin as f64) * 0.5).ceil() as u32 + 32;
    (tin, tout)
}

pub fn estimate_cost(owner: Owner, tokens_in: u32, tokens_out: u32) -> f64 {
    match owner {
        Owner::Local => 0.0,
        Owner::Chatgpt => {
            (tokens_in as f64) / 1_000_000.0 * CHATGPT_IN_PER_MILLION
                + (tokens_out as f64) / 1_000_000.0 * CHATGPT_OUT_PER_MILLION
        }
        Owner::Claude => {
            (tokens_in as f64) / 1_000_000.0 * CLAUDE_IN_PER_MILLION
                + (tokens_out as f64) / 1_000_000.0 * CLAUDE_OUT_PER_MILLION
        }
        Owner::Cursor => {
            let combined = tokens_in as f64 + tokens_out as f64;
            (combined / 1000.0) * CURSOR_PER_1K_COMBINED
        }
    }
}

/// True when a paid owner would send at $0 — illegal, must block missing_estimate.
pub fn paid_zero_is_illegal(owner: Owner, cost: f64) -> bool {
    owner.is_paid() && cost.is_finite() && cost == 0.0
}
