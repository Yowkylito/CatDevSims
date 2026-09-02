//! Classify/send contracts. Field names serialize to the locked TS camelCase API.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Routing owner. Default is exactly one; fan-out is opt-in in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Local,
    Chatgpt,
    Cursor,
    Claude,
}

impl Owner {
    pub fn as_str(self) -> &'static str {
        match self {
            Owner::Local => "local",
            Owner::Chatgpt => "chatgpt",
            Owner::Cursor => "cursor",
            Owner::Claude => "claude",
        }
    }

    /// Paid owners must never send with a $0 estimate.
    pub fn is_paid(self) -> bool {
        matches!(self, Owner::Chatgpt | Owner::Cursor | Owner::Claude)
    }
}

impl std::fmt::Display for Owner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyRequest {
    pub prompt: String,
    pub fan_out_enabled: bool,
    pub daily_spent_usd: f64,
    pub daily_cap_usd: f64,
    pub per_run_cap_usd: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockReason {
    DailyCap,
    PerRunCap,
    MissingEstimate,
}

impl BlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockReason::DailyCap => "daily_cap",
            BlockReason::PerRunCap => "per_run_cap",
            BlockReason::MissingEstimate => "missing_estimate",
        }
    }
}

/// `false` | `{ owners, estCostUsd }` — matches the TS union exactly.
#[derive(Debug, Clone, PartialEq)]
pub enum FanOut {
    Off,
    On {
        owners: Vec<Owner>,
        est_cost_usd: f64,
    },
}

impl FanOut {
    pub fn is_off(&self) -> bool {
        matches!(self, FanOut::Off)
    }

    pub fn is_truthy(&self) -> bool {
        !self.is_off()
    }
}

impl Serialize for FanOut {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            FanOut::Off => serializer.serialize_bool(false),
            FanOut::On {
                owners,
                est_cost_usd,
            } => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Body<'a> {
                    owners: &'a [Owner],
                    est_cost_usd: f64,
                }
                Body {
                    owners,
                    est_cost_usd: *est_cost_usd,
                }
                .serialize(serializer)
            }
        }
    }
}

impl<'de> Deserialize<'de> for FanOut {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Flag(bool),
            Body {
                owners: Vec<Owner>,
                #[serde(rename = "estCostUsd")]
                est_cost_usd: f64,
            },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Flag(false) => Ok(FanOut::Off),
            Raw::Flag(true) => Err(serde::de::Error::custom(
                "fanOut true is invalid; use {owners, estCostUsd} or false",
            )),
            Raw::Body {
                owners,
                est_cost_usd,
            } => Ok(FanOut::On {
                owners,
                est_cost_usd,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyResult {
    pub owner: Owner,
    pub est_tokens_in: u32,
    pub est_tokens_out: u32,
    /// Must be finite, never omitted. Paid + 0 => missing_estimate (not a send).
    pub est_cost_usd: f64,
    pub fan_out: FanOut,
    pub cache_hit: bool,
    pub blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_reason: Option<BlockReason>,
    /// One line for the composer.
    pub reason: String,
}

impl ClassifyResult {
    pub fn cost_is_finite(&self) -> bool {
        self.est_cost_usd.is_finite()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub ok: bool,
    pub owner: Owner,
    pub text: String,
    pub degraded: bool,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SendError {
    #[error("classify blocked ({})", .0.map(|r| r.as_str()).unwrap_or("unknown"))]
    Blocked(Option<BlockReason>),
    #[error("missing or non-finite cost estimate; send is dead")]
    MissingEstimate,
    #[error("router lie: fanOut is set while fanOutEnabled is false")]
    RouterLie,
    #[error("claude/chatgpt payload must not contain a repo path")]
    RepoDump,
    #[error("send aborted")]
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSnapshot {
    pub daily_spent_usd: f64,
    pub daily_cap_usd: f64,
    pub monthly_spent_usd: f64,
    pub monthly_cap_usd: f64,
    pub per_run_cap_usd: f64,
}
