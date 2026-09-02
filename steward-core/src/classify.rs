//! Local, free heuristic classifier. Zero tokens, zero dollars.
//! Must never touch MockBackends — call_count stays 0.

use crate::cache::PromptCache;
use crate::pricing::{estimate_cost, estimate_tokens, paid_zero_is_illegal};
use crate::types::{BlockReason, ClassifyRequest, ClassifyResult, FanOut, Owner};

/// Classify a prompt. Heuristic only — no backend I/O.
pub fn classify(req: &ClassifyRequest, cache: &PromptCache) -> ClassifyResult {
    // Cache hit: only legal zero-cost path (owner=local, cacheHit=true).
    if cache.has(&req.prompt) {
        return ClassifyResult {
            owner: Owner::Local,
            est_tokens_in: 0,
            est_tokens_out: 0,
            est_cost_usd: 0.0,
            fan_out: FanOut::Off,
            cache_hit: true,
            blocked: false,
            block_reason: None,
            reason: "cache hit — local, $0, no backend".into(),
        };
    }

    let owner = pick_owner(&req.prompt);
    let (tin, tout) = estimate_tokens(&req.prompt);
    let cost = estimate_cost(owner, tin, tout);

    // If fanOutEnabled is false, fanOut MUST be false (never lie).
    let fan_out = if req.fan_out_enabled {
        FanOut::On {
            owners: vec![owner],
            est_cost_usd: if cost.is_finite() { cost } else { 0.0 },
        }
    } else {
        FanOut::Off
    };

    if !cost.is_finite() || paid_zero_is_illegal(owner, cost) || (owner.is_paid() && tin == 0 && tout == 0)
    {
        return ClassifyResult {
            owner,
            est_tokens_in: tin,
            est_tokens_out: tout,
            est_cost_usd: 0.0,
            fan_out: force_fanout_honest(req.fan_out_enabled, fan_out, 0.0, owner),
            cache_hit: false,
            blocked: true,
            block_reason: Some(BlockReason::MissingEstimate),
            reason: "no finite cost estimate — send is dead".into(),
        };
    }

    if owner.is_paid() && cost > req.per_run_cap_usd {
        return ClassifyResult {
            owner,
            est_tokens_in: tin,
            est_tokens_out: tout,
            est_cost_usd: cost,
            fan_out: force_fanout_honest(req.fan_out_enabled, fan_out, cost, owner),
            cache_hit: false,
            blocked: true,
            block_reason: Some(BlockReason::PerRunCap),
            reason: format!(
                "{owner} est ${cost:.6} exceeds per-run cap ${:.2}",
                req.per_run_cap_usd
            ),
        };
    }

    let remaining = req.daily_cap_usd - req.daily_spent_usd;
    if owner.is_paid() && cost > remaining {
        return ClassifyResult {
            owner,
            est_tokens_in: tin,
            est_tokens_out: tout,
            est_cost_usd: cost,
            fan_out: force_fanout_honest(req.fan_out_enabled, fan_out, cost, owner),
            cache_hit: false,
            blocked: true,
            block_reason: Some(BlockReason::DailyCap),
            reason: format!(
                "{owner} est ${cost:.6} exceeds remaining daily ${remaining:.2}"
            ),
        };
    }

    ClassifyResult {
        owner,
        est_tokens_in: tin,
        est_tokens_out: tout,
        est_cost_usd: cost,
        fan_out: force_fanout_honest(req.fan_out_enabled, fan_out, cost, owner),
        cache_hit: false,
        blocked: false,
        block_reason: None,
        reason: format!("{owner} · est ${cost:.6} · {tin} in / {tout} out"),
    }
}

fn force_fanout_honest(
    fan_out_enabled: bool,
    fan_out: FanOut,
    cost: f64,
    owner: Owner,
) -> FanOut {
    if !fan_out_enabled {
        return FanOut::Off;
    }
    match fan_out {
        FanOut::Off => FanOut::On {
            owners: vec![owner],
            est_cost_usd: cost,
        },
        other => other,
    }
}

/// Owner pick:
/// - chatgpt = drafts/summaries
/// - cursor  = repo/files/PRs (path-like tokens, PR/diff/commit/branch language)
/// - claude  = hard reasoning / long coding
/// - local   = cache hit (handled above) or degrade when blocked (send path)
fn pick_owner(prompt: &str) -> Owner {
    let p = prompt.to_lowercase();

    if has_cursor_signal(prompt, &p) {
        return Owner::Cursor;
    }
    if has_draft_signal(&p) {
        return Owner::Chatgpt;
    }
    if has_claude_signal(&p, prompt.len()) {
        return Owner::Claude;
    }
    // Default ONE owner: short generic copy → chatgpt; otherwise claude.
    if prompt.len() > 280 || looks_like_code(&p) {
        Owner::Claude
    } else {
        Owner::Chatgpt
    }
}

fn has_cursor_signal(prompt: &str, lower: &str) -> bool {
    if has_path_like_token(prompt) {
        return true;
    }
    const KEYS: &[&str] = &[
        "pull request",
        "merge request",
        " the pr",
        "this pr",
        "open a pr",
        "diff",
        "commit",
        "branch",
        "repo",
        "codebase",
        "working tree",
        "merge conflict",
    ];
    if KEYS.iter().any(|k| lower.contains(k)) {
        return true;
    }
    // standalone "pr" token
    lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|t| t == "pr")
}

fn has_path_like_token(prompt: &str) -> bool {
    for raw in prompt.split_whitespace() {
        let t = raw.trim_matches(|c: char| ".,;:()[]{}\"'`".contains(c));
        if t.contains('/') || t.contains('\\') {
            if t.contains("://") {
                continue;
            }
            return true;
        }
        if looks_like_filename(t) {
            return true;
        }
    }
    false
}

fn looks_like_filename(t: &str) -> bool {
    const EXTS: &[&str] = &[
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".kt", ".swift",
        ".c", ".h", ".cpp", ".toml", ".json", ".md", ".yml", ".yaml", ".lock",
    ];
    EXTS.iter().any(|e| t.len() > e.len() && t.ends_with(e))
}

fn has_draft_signal(lower: &str) -> bool {
    const KEYS: &[&str] = &[
        "draft",
        "summar",
        "rewrite",
        "email",
        "bullet",
        "outline",
        "tldr",
        "proofread",
        "subject line",
        "blurb",
        "press release",
    ];
    KEYS.iter().any(|k| lower.contains(k))
}

fn has_claude_signal(lower: &str, len: usize) -> bool {
    if len > 800 {
        return true;
    }
    const KEYS: &[&str] = &[
        "reason",
        "implement",
        "architect",
        "algorithm",
        "refactor",
        "prove",
        "step by step",
        "write a function",
        "write a program",
        "debug",
        "complexity",
        "invariant",
        "long coding",
        "hard problem",
    ];
    KEYS.iter().any(|k| lower.contains(k))
}

fn looks_like_code(lower: &str) -> bool {
    lower.contains("fn ")
        || lower.contains("def ")
        || lower.contains("function ")
        || lower.contains("impl ")
        || lower.contains("class ")
        || lower.contains("```")
}
