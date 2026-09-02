//! Local SQLite run history. Prompt hash, owner, tokens in/out, cost, backend.

use rusqlite::{params, Connection};
use std::path::Path;

use crate::cache::PromptCache;
use crate::types::{BudgetSnapshot, Owner};

#[derive(Debug)]
pub struct RunHistory {
    conn: Connection,
}

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub prompt_hash: String,
    pub owner: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub cost_usd: f64,
    pub backend: String,
}

impl RunHistory {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        let h = Self { conn };
        h.init()?;
        Ok(h)
    }

    pub fn open_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        let h = Self { conn };
        h.init()?;
        Ok(h)
    }

    fn init(&self) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_hash TEXT NOT NULL,
                owner TEXT NOT NULL,
                tokens_in INTEGER NOT NULL,
                tokens_out INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                backend TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
            "#,
        )?;
        Ok(())
    }

    pub fn record(&self, rec: &RunRecord) -> Result<(), rusqlite::Error> {
        let now = now_secs();
        self.conn.execute(
            "INSERT INTO runs (prompt_hash, owner, tokens_in, tokens_out, cost_usd, backend, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                rec.prompt_hash,
                rec.owner,
                rec.tokens_in as i64,
                rec.tokens_out as i64,
                rec.cost_usd,
                rec.backend,
                now
            ],
        )?;
        Ok(())
    }

    pub fn spent_since(&self, since_epoch_secs: i64) -> Result<f64, rusqlite::Error> {
        let sum: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0.0) FROM runs WHERE created_at >= ?1",
            params![since_epoch_secs],
            |row| row.get(0),
        )?;
        Ok(sum)
    }

    pub fn budget(
        &self,
        daily_cap: f64,
        per_run_cap: f64,
        monthly_cap: f64,
    ) -> Result<BudgetSnapshot, rusqlite::Error> {
        let now = now_secs();
        let day = 86400;
        let month = day * 30;
        Ok(BudgetSnapshot {
            daily_spent_usd: self.spent_since(now - day)?,
            daily_cap_usd: daily_cap,
            monthly_spent_usd: self.spent_since(now - month)?,
            monthly_cap_usd: monthly_cap,
            per_run_cap_usd: per_run_cap,
        })
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn record_send(
    history: &RunHistory,
    prompt: &str,
    owner: Owner,
    tokens_in: u32,
    tokens_out: u32,
    cost_usd: f64,
) -> Result<(), rusqlite::Error> {
    history.record(&RunRecord {
        prompt_hash: PromptCache::hash_prompt(prompt),
        owner: owner.as_str().to_string(),
        tokens_in,
        tokens_out,
        cost_usd,
        backend: owner.as_str().to_string(),
    })
}
