//! Identical-prompt cache. Hits are local, free, and must not tick mock backends.

use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub prompt_hash: String,
    pub response: String,
    pub owner_when_cached: String,
}

#[derive(Debug, Default)]
pub struct PromptCache {
    map: HashMap<String, CacheEntry>,
}

impl PromptCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn hash_prompt(prompt: &str) -> String {
        let mut h = Sha256::new();
        h.update(prompt.as_bytes());
        hex::encode(h.finalize())
    }

    pub fn has(&self, prompt: &str) -> bool {
        self.map.contains_key(&Self::hash_prompt(prompt))
    }

    pub fn get(&self, prompt: &str) -> Option<&CacheEntry> {
        self.map.get(&Self::hash_prompt(prompt))
    }

    pub fn put(&mut self, prompt: &str, response: impl Into<String>, owner: &str) {
        let hash = Self::hash_prompt(prompt);
        self.map.insert(
            hash.clone(),
            CacheEntry {
                prompt_hash: hash,
                response: response.into(),
                owner_when_cached: owner.to_string(),
            },
        );
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
