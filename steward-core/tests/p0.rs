//! P0 contract tests. Fail the build if any of these regress.

use steward_core::*;

fn caps_ok() -> ClassifyRequest {
    ClassifyRequest {
        prompt: String::new(),
        fan_out_enabled: false,
        daily_spent_usd: 0.0,
        daily_cap_usd: 5.0,
        per_run_cap_usd: 1.0,
    }
}

fn req(prompt: &str) -> ClassifyRequest {
    ClassifyRequest {
        prompt: prompt.into(),
        ..caps_ok()
    }
}

fn paid_result(owner: Owner, cost: f64) -> ClassifyResult {
    ClassifyResult {
        owner,
        est_tokens_in: 100,
        est_tokens_out: 50,
        est_cost_usd: cost,
        fan_out: FanOut::Off,
        cache_hit: false,
        blocked: false,
        block_reason: None,
        reason: "test".into(),
    }
}

#[test]
fn p0_classify_never_increments_mock_call_count() {
    let mut backends = MockBackends::new();
    let cache = PromptCache::new();
    assert_eq!(backends.call_count, 0);

    let prompts = [
        "summarize this email for the team",
        "open a PR for src/lib.rs and fix the diff",
        "reason step by step through this algorithm and implement it",
        "",
        "hello",
    ];
    for p in prompts {
        let _ = classify(&req(p), &cache);
    }
    assert_eq!(
        backends.call_count, 0,
        "classify is local/free — mock call_count must stay 0"
    );
    // classify_call_count must not exist; touching backends at all is a bug
    let _ = backends.chatgpt("should not have been called from classify");
    // reset by reconstructing
    backends = MockBackends::new();
    let _ = classify(&req("draft a blurb"), &cache);
    assert_eq!(backends.call_count(), 0);
}

#[test]
fn p0_send_blocked_does_not_call_backend() {
    let mut backends = MockBackends::new();
    let mut cache = PromptCache::new();
    let mut c = paid_result(Owner::Chatgpt, 0.01);
    c.blocked = true;
    c.block_reason = Some(BlockReason::DailyCap);

    let r = send(
        "summarize this",
        &c,
        false,
        &mut backends,
        &mut cache,
        None,
        None,
    );
    assert!(r.is_err(), "blocked classify must not send");
    assert_eq!(backends.call_count, 0);
}

#[test]
fn p0_missing_or_non_finite_est_cost_send_dead_zero_calls() {
    let mut cache = PromptCache::new();
    for cost in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut backends = MockBackends::new();
        let c = paid_result(Owner::Claude, cost);
        let r = send("hello", &c, false, &mut backends, &mut cache, None, None);
        assert!(r.is_err(), "non-finite cost {cost} must be send-dead");
        assert_eq!(backends.call_count, 0, "non-finite cost must not call backend");
        match r {
            Err(SendError::MissingEstimate) => {}
            other => panic!("expected MissingEstimate, got {other:?}"),
        }
    }
}

#[test]
fn p0_fanout_disabled_successful_send_is_exactly_one_mock_call() {
    let mut backends = MockBackends::new();
    let mut cache = PromptCache::new();
    let c = classify(&req("summarize the meeting notes into bullets"), &cache);
    assert!(!c.blocked, "fixture should be sendable: {}", c.reason);
    assert!(c.fan_out.is_off(), "fanOutEnabled=false => fanOut must be false");
    assert!(c.owner.is_paid());
    assert!(c.est_cost_usd.is_finite() && c.est_cost_usd > 0.0);

    let r = send(
        "summarize the meeting notes into bullets",
        &c,
        false,
        &mut backends,
        &mut cache,
        None,
        None,
    )
    .expect("send should succeed");
    assert!(r.ok);
    assert!(!r.degraded);
    assert_eq!(
        backends.call_count, 1,
        "fanOutEnabled=false => exactly one mock call, got {}",
        backends.call_count
    );
}

#[test]
fn p0_429_then_retry_does_not_bump_call_count_a_second_time() {
    let mut backends = MockBackends::new();
    backends.inject_429 = true;
    let mut cache = PromptCache::new();
    let c = classify(&req("draft a short status email"), &cache);
    assert!(!c.blocked, "{}", c.reason);
    assert_eq!(c.owner, Owner::Chatgpt);

    let r1 = send(
        "draft a short status email",
        &c,
        false,
        &mut backends,
        &mut cache,
        None,
        None,
    )
    .expect("429 degrades rather than hard-failing");
    assert!(r1.degraded, "429 must degrade to local");
    assert_eq!(r1.owner, Owner::Local);
    let after_first = backends.call_count;
    assert!(
        after_first <= 1,
        "original 429 may count as one call, not more; got {after_first}"
    );

    let r2 = send(
        "draft a short status email",
        &c,
        false,
        &mut backends,
        &mut cache,
        None,
        None,
    )
    .expect("retry after 429 degrades");
    assert!(r2.degraded);
    assert_eq!(
        backends.call_count, after_first,
        "retry after 429 must not increment call_count a second time"
    );
}

#[test]
fn p0_paid_owner_zero_cost_is_blocked_missing_estimate() {
    let cache = PromptCache::new();
    // Empty prompt: cannot estimate > 0 → missing_estimate, not a send.
    let empty = classify(&req(""), &cache);
    assert!(empty.blocked);
    assert_eq!(empty.block_reason, Some(BlockReason::MissingEstimate));
    assert!(empty.owner.is_paid() || empty.owner == Owner::Chatgpt);

    for owner in [Owner::Chatgpt, Owner::Cursor, Owner::Claude] {
        let mut backends = MockBackends::new();
        let mut cache = PromptCache::new();
        let c = paid_result(owner, 0.0);
        let r = send("hello world", &c, false, &mut backends, &mut cache, None, None);
        assert!(
            matches!(r, Err(SendError::MissingEstimate)),
            "{owner} with $0 must be missing_estimate, got {r:?}"
        );
        assert_eq!(backends.call_count, 0);
    }
}

#[test]
fn p0_router_lie_fanout_object_while_disabled_send_dead() {
    let mut backends = MockBackends::new();
    let mut cache = PromptCache::new();
    let mut c = paid_result(Owner::Chatgpt, 0.01);
    c.fan_out = FanOut::On {
        owners: vec![Owner::Chatgpt, Owner::Claude],
        est_cost_usd: 0.04,
    };
    let r = send(
        "summarize this",
        &c,
        false, // fanOutEnabled = false
        &mut backends,
        &mut cache,
        None,
        None,
    );
    assert!(
        r.is_err(),
        "send must not proceed with fanOut truthy while fanOutEnabled is false; got {r:?}"
    );
    assert_eq!(backends.call_count, 0);
    assert!(matches!(r, Err(SendError::RouterLie)));
}

#[test]
fn p0_claude_chatgpt_payload_with_repo_path_fails_no_call() {
    let mut cache = PromptCache::new();
    for (owner, path) in [
        (Owner::Chatgpt, "/Users/x/repo"),
        (Owner::Claude, r"C:\proj"),
        (Owner::Chatgpt, r"C:\proj"),
        (Owner::Claude, "/Users/x/repo"),
    ] {
        let mut backends = MockBackends::new();
        let c = paid_result(owner, 0.02);
        let r = send(
            "draft a summary",
            &c,
            false,
            &mut backends,
            &mut cache,
            Some(path),
            None,
        );
        assert!(
            matches!(r, Err(SendError::RepoDump)),
            "{owner} payload {path:?} must fail, got {r:?}"
        );
        assert_eq!(backends.call_count, 0, "repo-dump payload must not call backend");
    }
}

#[test]
fn p0_local_cache_hit_is_only_legal_zero_and_does_not_tick_backend() {
    let mut backends = MockBackends::new();
    let mut cache = PromptCache::new();
    cache.put("hello world", "cached answer", "chatgpt");

    let c = classify(&req("hello world"), &cache);
    assert_eq!(c.owner, Owner::Local);
    assert!(c.cache_hit);
    assert_eq!(c.est_cost_usd, 0.0);
    assert!(!c.blocked);
    assert!(c.fan_out.is_off());

    let r = send(
        "hello world",
        &c,
        false,
        &mut backends,
        &mut cache,
        None,
        None,
    )
    .expect("cache hit is the legal zero-cost send");
    assert!(r.ok);
    assert_eq!(r.owner, Owner::Local);
    assert_eq!(r.cost_usd, 0.0);
    assert_eq!(r.text, "cached answer");
    assert_eq!(backends.call_count, 0, "cache hit must not tick mock backend");
}

#[test]
fn classify_forces_fanout_false_when_toggle_off() {
    let cache = PromptCache::new();
    let c = classify(&req("summarize this paragraph"), &cache);
    assert!(c.fan_out.is_off());
}

#[test]
fn payload_detects_unix_and_windows_abs_paths() {
    assert!(contains_repo_path("/Users/x/repo"));
    assert!(contains_repo_path(r"C:\proj"));
    assert!(contains_repo_path("see C:\\proj please"));
    assert!(!contains_repo_path("summarize this email"));
}
