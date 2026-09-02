//! Tauri 2 shell around steward-core. GUI is optional; cargo test lives in steward-core.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use steward_core::{
    classify, record_send, send, BudgetSnapshot, ClassifyRequest, ClassifyResult, MockBackends,
    PromptCache, RunHistory, DEFAULT_DAILY_CAP_USD, DEFAULT_PER_RUN_CAP_USD,
    MONTHLY_CAP_MULTIPLIER,
};

pub struct AppState {
    cache: Mutex<PromptCache>,
    backends: Mutex<MockBackends>,
    history: Mutex<RunHistory>,
    abort: AtomicBool,
    daily_spent: Mutex<f64>,
    daily_cap: Mutex<f64>,
    per_run_cap: Mutex<f64>,
}

impl AppState {
    fn new() -> Self {
        let history = RunHistory::open_memory().expect("in-memory sqlite");
        Self {
            cache: Mutex::new(PromptCache::new()),
            backends: Mutex::new(MockBackends::new()),
            history: Mutex::new(history),
            abort: AtomicBool::new(false),
            daily_spent: Mutex::new(0.0),
            daily_cap: Mutex::new(DEFAULT_DAILY_CAP_USD),
            per_run_cap: Mutex::new(DEFAULT_PER_RUN_CAP_USD),
        }
    }
}

#[tauri::command]
fn classify_prompt(
    prompt: String,
    fan_out_enabled: bool,
    state: tauri::State<AppState>,
) -> ClassifyResult {
    let daily_spent = *state.daily_spent.lock().expect("daily_spent");
    let daily_cap = *state.daily_cap.lock().expect("daily_cap");
    let per_run_cap = *state.per_run_cap.lock().expect("per_run_cap");
    let cache = state.cache.lock().expect("cache");
    classify(
        &ClassifyRequest {
            prompt,
            fan_out_enabled,
            daily_spent_usd: daily_spent,
            daily_cap_usd: daily_cap,
            per_run_cap_usd: per_run_cap,
        },
        &cache,
    )
}

#[tauri::command]
fn send_prompt(
    prompt: String,
    fan_out_enabled: bool,
    state: tauri::State<AppState>,
) -> Result<steward_core::SendOutcome, String> {
    state.abort.store(false, Ordering::SeqCst);

    let daily_spent = *state.daily_spent.lock().expect("daily_spent");
    let daily_cap = *state.daily_cap.lock().expect("daily_cap");
    let per_run_cap = *state.per_run_cap.lock().expect("per_run_cap");

    let classified = {
        let cache = state.cache.lock().expect("cache");
        classify(
            &ClassifyRequest {
                prompt: prompt.clone(),
                fan_out_enabled,
                daily_spent_usd: daily_spent,
                daily_cap_usd: daily_cap,
                per_run_cap_usd: per_run_cap,
            },
            &cache,
        )
    };

    let mut cache = state.cache.lock().expect("cache");
    let mut backends = state.backends.lock().expect("backends");
    let outcome = send(
        &prompt,
        &classified,
        fan_out_enabled,
        &mut backends,
        &mut cache,
        None,
        Some(&state.abort),
    )
    .map_err(|e| e.to_string())?;

    if outcome.ok && !outcome.degraded && outcome.cost_usd > 0.0 {
        *state.daily_spent.lock().expect("daily_spent") += outcome.cost_usd;
        let history = state.history.lock().expect("history");
        let _ = record_send(
            &history,
            &prompt,
            outcome.owner,
            classified.est_tokens_in,
            classified.est_tokens_out,
            outcome.cost_usd,
        );
    }
    Ok(outcome)
}

#[tauri::command]
fn stop_send(state: tauri::State<AppState>) {
    state.abort.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn budget(state: tauri::State<AppState>) -> BudgetSnapshot {
    let daily_spent = *state.daily_spent.lock().expect("daily_spent");
    let daily_cap = *state.daily_cap.lock().expect("daily_cap");
    let per_run_cap = *state.per_run_cap.lock().expect("per_run_cap");
    BudgetSnapshot {
        daily_spent_usd: daily_spent,
        daily_cap_usd: daily_cap,
        monthly_spent_usd: daily_spent,
        monthly_cap_usd: daily_cap * MONTHLY_CAP_MULTIPLIER,
        per_run_cap_usd: per_run_cap,
    }
}

#[tauri::command]
fn mock_call_count(state: tauri::State<AppState>) -> u32 {
    state.backends.lock().expect("backends").call_count
}

#[tauri::command]
fn store_key(owner: String, secret: String) -> Result<(), String> {
    steward_core::keys::set_secret(&owner, &secret).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            classify_prompt,
            send_prompt,
            stop_send,
            budget,
            mock_call_count,
            store_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running Steward");
}
