//! Send gate. Refuse before any backend mock is touched when the contract is violated.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::backends::{BackendError, MockBackends};
use crate::cache::PromptCache;
use crate::payload::{build_brief, contains_repo_path};
use crate::types::{ClassifyResult, Owner, SendError, SendOutcome};

/// Run the send gate, then at most one mock call when fanOutEnabled is false.
///
/// Refuses (0 calls) if:
/// - classify.blocked
/// - estCostUsd missing / non-finite
/// - paid owner with estCostUsd == 0
/// - fanOutEnabled == false but fanOut is truthy (router lie)
/// - claude/chatgpt payload contains a repo path
pub fn send(
    prompt: &str,
    classify: &ClassifyResult,
    fan_out_enabled: bool,
    backends: &mut MockBackends,
    cache: &mut PromptCache,
    payload_override: Option<&str>,
    abort: Option<&AtomicBool>,
) -> Result<SendOutcome, SendError> {
    if abort.map(|a| a.load(Ordering::SeqCst)).unwrap_or(false) {
        return Err(SendError::Aborted);
    }

    if classify.blocked {
        return Err(SendError::Blocked(classify.block_reason));
    }

    if !classify.est_cost_usd.is_finite() {
        return Err(SendError::MissingEstimate);
    }

    if classify.owner.is_paid() && classify.est_cost_usd == 0.0 {
        return Err(SendError::MissingEstimate);
    }

    // Router lie: fan-out object while the UI toggle is off. Send is dead.
    // (Force-correct would also be legal; we refuse so a truthy fanOut cannot proceed.)
    if !fan_out_enabled && classify.fan_out.is_truthy() {
        return Err(SendError::RouterLie);
    }

    let payload = payload_override
        .map(|s| s.to_string())
        .unwrap_or_else(|| build_brief(classify.owner, prompt));

    if matches!(classify.owner, Owner::Claude | Owner::Chatgpt)
        && (contains_repo_path(&payload) || contains_repo_path(prompt))
    {
        return Err(SendError::RepoDump);
    }

    // Only legal zero-cost send: local + cacheHit. Do not tick backends.
    if classify.owner == Owner::Local && classify.cache_hit {
        let text = cache
            .get(prompt)
            .map(|e| e.response.clone())
            .unwrap_or_else(|| "(cache hit)".into());
        return Ok(SendOutcome {
            ok: true,
            owner: Owner::Local,
            text,
            degraded: false,
            cost_usd: 0.0,
        });
    }

    if abort.map(|a| a.load(Ordering::SeqCst)).unwrap_or(false) {
        return Err(SendError::Aborted);
    }

    // fanOutEnabled === false => exactly ONE backend mock call (or degrade on 429).
    let result = match classify.owner {
        Owner::Chatgpt => backends.chatgpt(&payload),
        Owner::Claude => backends.claude(&payload),
        Owner::Cursor => backends.cursor(&payload),
        Owner::Local => {
            return Ok(SendOutcome {
                ok: true,
                owner: Owner::Local,
                text: payload,
                degraded: false,
                cost_usd: 0.0,
            });
        }
    };

    match result {
        Ok(text) => {
            cache.put(prompt, &text, classify.owner.as_str());
            Ok(SendOutcome {
                ok: true,
                owner: classify.owner,
                text,
                degraded: false,
                cost_usd: classify.est_cost_usd,
            })
        }
        Err(BackendError::RateLimited) => {
            // Do NOT retry-storm. Degrade to local. Retry must not increment again
            // (MockBackends.hit_429 swallows subsequent increments).
            Ok(SendOutcome {
                ok: true,
                owner: Owner::Local,
                text: "degraded to local after HTTP 429 (no retry)".into(),
                degraded: true,
                cost_usd: 0.0,
            })
        }
    }
}
